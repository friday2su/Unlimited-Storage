const TelegramBot = require('node-telegram-bot-api');
const fs = require('fs-extra');
const path = require('path');

class CloudStreamingService {
    constructor() {
        this.botToken = process.env.TELEGRAM_BOT_TOKEN;
        this.primaryChannelId = process.env.TELEGRAM_CHANNEL_ID;
        this.backupChannelIds = process.env.TELEGRAM_BACKUP_CHANNELS ? 
            process.env.TELEGRAM_BACKUP_CHANNELS.split(',').map(id => id.trim()) : [];
        
        if (!this.botToken || !this.primaryChannelId) {
            console.warn('Telegram credentials not configured. Cloud streaming will be disabled.');
            this.bot = null;
            return;
        }

        this.bot = new TelegramBot(this.botToken, { polling: false });
    }

    /**
     * Stream video directly from Telegram with range support
     */
    async streamVideo(telegramData, range = null, originalName = null) {
        if (!this.bot || !telegramData.uploaded) {
            throw new Error('Cannot stream: Telegram service not available or video not uploaded');
        }

        // Store original name in telegramData for use in streaming methods
        if (originalName) {
            telegramData.originalName = originalName;
        }

        try {
            if (telegramData.uploadMethod === 'single') {
                return await this.streamSingleFile(telegramData, range);
            } else if (telegramData.uploadMethod === 'chunked') {
                return await this.streamChunkedFile(telegramData, range);
            }
            
            throw new Error('Unknown upload method');
        } catch (error) {
            console.error('Streaming error:', error);
            throw error;
        }
    }

    /**
     * Stream a single file from Telegram
     */
    async streamSingleFile(telegramData, range) {
        try {
            // Get file info first to get the download URL
            const fileInfo = await this.bot.getFile(telegramData.fileId);
            const fileUrl = `https://api.telegram.org/file/bot${this.botToken}/${fileInfo.file_path}`;
            
            // Use axios to stream the file with range support
            const axios = require('axios');
            
            // Determine content type from file extension
            const contentType = this.getContentType(telegramData.originalName || 'video.mp4');
            
            // Configure request headers for range requests if needed
            const headers = {};
            if (range) {
                headers['Range'] = range;
            }
            
            // Create the stream request
            const response = await axios({
                method: 'GET',
                url: fileUrl,
                responseType: 'stream',
                headers: headers
            });
            
            return {
                stream: response.data,
                contentLength: telegramData.size,
                contentType: contentType,
                acceptsRanges: true,
                range: range
            };
        } catch (error) {
            // Try backup channels if primary fails
            if (telegramData.backups && telegramData.backups.length > 0) {
                for (const backup of telegramData.backups) {
                    if (backup.uploaded && backup.uploadMethod === 'single') {
                        try {
                            // Get file info and URL for backup
                            const fileInfo = await this.bot.getFile(backup.fileId);
                            const fileUrl = `https://api.telegram.org/file/bot${this.botToken}/${fileInfo.file_path}`;
                            
                            const axios = require('axios');
                            const contentType = this.getContentType(telegramData.originalName || 'video.mp4');
                            
                            const headers = {};
                            if (range) {
                                headers['Range'] = range;
                            }
                            
                            const response = await axios({
                                method: 'GET',
                                url: fileUrl,
                                responseType: 'stream',
                                headers: headers
                            });
                            
                            return {
                                stream: response.data,
                                contentLength: backup.size || telegramData.size,
                                contentType: contentType,
                                acceptsRanges: true,
                                range: range
                            };
                        } catch (backupError) {
                            console.warn(`Backup streaming failed:`, backupError.message);
                            continue;
                        }
                    }
                }
            }
            throw error;
        }
    }

    /**
     * Stream chunked files from Telegram (reconstructed on-the-fly)
     */
    async streamChunkedFile(telegramData, range) {
        console.log(`Streaming chunked file with ${telegramData.chunks.length} chunks`);
        
        try {
            // For large chunked files, we'll use a different approach
            // Instead of trying to get file URLs which can fail, we'll stream the chunks directly
            const { PassThrough } = require('stream');
            const axios = require('axios');
            
            let totalSize = 0;
            if (telegramData.chunks) {
                totalSize = telegramData.chunks.reduce((sum, chunk) => sum + (chunk.size || 0), 0);
            }
            
            const reconstructedStream = new PassThrough();
            
            // Stream chunks sequentially
            const streamChunks = async () => {
                try {
                    for (let i = 0; i < telegramData.chunks.length; i++) {
                        const chunk = telegramData.chunks[i];
                        console.log(`Streaming chunk ${i + 1}/${telegramData.chunks.length} (size: ${chunk.size})`);
                        
                        try {
                            // Use getFile to get the download URL
                            const fileInfo = await this.bot.getFile(chunk.fileId);
                            const fileUrl = `https://api.telegram.org/file/bot${this.botToken}/${fileInfo.file_path}`;
                            
                            const response = await axios({
                                method: 'GET',
                                url: fileUrl,
                                responseType: 'stream',
                                timeout: 30000 // 30 second timeout
                            });
                            
                            // Pipe chunk data to the reconstructed stream
                            await new Promise((resolve, reject) => {
                                response.data.on('data', (data) => {
                                    reconstructedStream.write(data);
                                });
                                
                                response.data.on('end', () => {
                                    console.log(`Chunk ${i + 1} streamed successfully`);
                                    resolve();
                                });
                                
                                response.data.on('error', (error) => {
                                    console.error(`Error streaming chunk ${i + 1}:`, error);
                                    reject(error);
                                });
                            });
                            
                        } catch (chunkError) {
                            console.error(`Failed to stream chunk ${i + 1}:`, chunkError.message);
                            // If a chunk fails, we can't continue the stream
                            throw chunkError;
                        }
                    }
                    
                    // End the stream after all chunks are processed
                    reconstructedStream.end();
                    console.log('All chunks streamed successfully');
                    
                } catch (error) {
                    console.error('Error in chunk streaming:', error);
                    reconstructedStream.destroy(error);
                }
            };
            
            // Start streaming chunks in the background
            streamChunks();
            
            const contentType = this.getContentType(telegramData.originalName || 'video.mp4');
            
            return {
                stream: reconstructedStream,
                contentLength: totalSize,
                contentType: contentType,
                acceptsRanges: false, // Range requests not supported for chunked files
                range: null
            };
            
        } catch (error) {
            console.error('Chunked file streaming setup failed:', error);
            throw new Error(`Cannot stream chunked file: ${error.message}`);
        }
    }

    /**
     * Get content type from file extension
     */
    getContentType(filename) {
        const ext = path.extname(filename).toLowerCase();
        const mimeTypes = {
            '.mp4': 'video/mp4',
            '.webm': 'video/webm',
            '.ogg': 'video/ogg',
            '.ogv': 'video/ogg',
            '.avi': 'video/x-msvideo',
            '.mov': 'video/quicktime',
            '.wmv': 'video/x-ms-wmv',
            '.flv': 'video/x-flv',
            '.mkv': 'video/x-matroska',
            '.m4v': 'video/x-m4v',
            '.3gp': 'video/3gpp'
        };
        return mimeTypes[ext] || 'video/mp4';
    }

    /**
     * Get video file info for streaming
     */
    async getVideoStreamInfo(telegramData) {
        if (!telegramData.uploaded) {
            throw new Error('Video not uploaded to Telegram');
        }

        try {
            if (telegramData.uploadMethod === 'single') {
                const fileInfo = await this.bot.getFile(telegramData.fileId);
                return {
                    size: fileInfo.file_size,
                    contentType: 'video/mp4',
                    supportsRangeRequests: true,
                    method: 'single'
                };
            } else if (telegramData.uploadMethod === 'chunked') {
                const totalSize = telegramData.chunks.reduce((sum, chunk) => sum + (chunk.size || 0), 0);
                return {
                    size: totalSize,
                    contentType: 'video/mp4',
                    supportsRangeRequests: false,
                    method: 'chunked',
                    chunks: telegramData.chunks.length
                };
            }
        } catch (error) {
            console.error('Error getting stream info:', error);
            throw error;
        }
    }

    /**
     * Create a thumbnail from Telegram video file
     */
    async generateThumbnailFromTelegram(telegramData, videoId) {
        if (!this.bot || !telegramData.uploaded) {
            return null;
        }

        // Skip thumbnail generation if disabled
        if (process.env.ENABLE_THUMBNAILS === 'false') {
            console.log('Thumbnail generation is disabled');
            return null;
        }

        try {
            // Create a temporary file for thumbnail generation
            const tempDir = path.join(__dirname, '..', 'temp');
            await fs.ensureDir(tempDir);
            
            const tempVideoPath = path.join(tempDir, `temp_${videoId}.mp4`);
            const thumbnailPath = path.join(tempDir, `thumb_${videoId}.jpg`);

            // Download only a small portion of the video for thumbnail generation
            let fileStream;
            if (telegramData.uploadMethod === 'single') {
                fileStream = this.bot.getFileStream(telegramData.fileId);
            } else {
                // For chunked files, just use the first chunk for thumbnail
                fileStream = this.bot.getFileStream(telegramData.chunks[0].fileId);
            }

            // Save temporary file with size limit
            const writeStream = fs.createWriteStream(tempVideoPath);
            let bytesWritten = 0;
            const maxBytes = 2 * 1024 * 1024; // Reduced to 2MB for faster processing

            await new Promise((resolve, reject) => {
                fileStream.on('data', (chunk) => {
                    if (bytesWritten + chunk.length <= maxBytes) {
                        writeStream.write(chunk);
                        bytesWritten += chunk.length;
                    } else {
                        // Write partial chunk if needed
                        const remainingBytes = maxBytes - bytesWritten;
                        if (remainingBytes > 0) {
                            writeStream.write(chunk.slice(0, remainingBytes));
                        }
                        fileStream.destroy();
                        writeStream.end();
                    }
                });

                fileStream.on('end', () => {
                    writeStream.end();
                });

                fileStream.on('error', reject);
                writeStream.on('finish', resolve);
                writeStream.on('error', reject);
            });

            // Check if temp file exists and has content
            const tempStats = await fs.stat(tempVideoPath);
            if (tempStats.size === 0) {
                console.log('Temp video file is empty, skipping thumbnail generation');
                await fs.remove(tempVideoPath).catch(() => {});
                return null;
            }

            // Generate thumbnail using FFmpeg with error recovery
            const ffmpeg = require('fluent-ffmpeg');
            let thumbnailGenerated = false;
            
            try {
                await new Promise((resolve, reject) => {
                    const timeout = setTimeout(() => {
                        reject(new Error('Thumbnail generation timeout'));
                    }, 10000); // 10 second timeout
                    
                    ffmpeg(tempVideoPath)
                        .on('end', () => {
                            clearTimeout(timeout);
                            thumbnailGenerated = true;
                            resolve();
                        })
                        .on('error', (err) => {
                            clearTimeout(timeout);
                            reject(err);
                        })
                        .screenshots({
                            timestamps: ['0%'], // Take screenshot at the beginning
                            filename: `thumb_${videoId}.jpg`,
                            folder: tempDir,
                            size: '320x180'
                        });
                });
            } catch (ffmpegError) {
                console.log('FFmpeg thumbnail generation failed, will use placeholder');
                await fs.remove(tempVideoPath).catch(() => {});
                return null;
            }

            // Read thumbnail data
            const thumbnailData = await fs.readFile(thumbnailPath);
            
            // Clean up temp files asynchronously
            fs.remove(tempVideoPath).catch(() => {});
            fs.remove(thumbnailPath).catch(() => {});

            return {
                data: thumbnailData,
                contentType: 'image/jpeg',
                filename: `thumbnail_${videoId}.jpg`
            };

        } catch (error) {
            console.error('Error generating thumbnail from Telegram:', error);
            return null;
        }
    }

    /**
     * Check if video is accessible from Telegram
     */
    async checkVideoAccess(telegramData) {
        if (!this.bot || !telegramData.uploaded) {
            return { accessible: false, reason: 'Service not configured or video not uploaded' };
        }

        try {
            if (telegramData.uploadMethod === 'single') {
                const fileInfo = await this.bot.getFile(telegramData.fileId);
                return {
                    accessible: true,
                    size: fileInfo.file_size,
                    method: 'single'
                };
            } else if (telegramData.uploadMethod === 'chunked') {
                // Check first chunk accessibility
                const firstChunk = telegramData.chunks[0];
                const fileInfo = await this.bot.getFile(firstChunk.fileId);
                return {
                    accessible: true,
                    method: 'chunked',
                    chunks: telegramData.chunks.length,
                    firstChunkSize: fileInfo.file_size
                };
            }
        } catch (error) {
            return {
                accessible: false,
                error: error.message
            };
        }
    }
}

module.exports = CloudStreamingService;
