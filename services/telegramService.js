const TelegramBot = require('node-telegram-bot-api');
const fs = require('fs-extra');
const path = require('path');

class TelegramService {
    constructor() {
        this.botToken = process.env.TELEGRAM_BOT_TOKEN;
        this.primaryChannelId = process.env.TELEGRAM_CHANNEL_ID;
        this.backupChannelIds = process.env.TELEGRAM_BACKUP_CHANNELS ? 
            process.env.TELEGRAM_BACKUP_CHANNELS.split(',').map(id => id.trim()) : [];
        
        if (!this.botToken || !this.primaryChannelId) {
            console.warn('Telegram credentials not configured. Video backup to Telegram will be disabled.');
            this.bot = null;
            return;
        }

        this.bot = new TelegramBot(this.botToken, { 
            polling: false,
            filepath: false // This disables the deprecation warning about content-type
        });
        this.maxFileSize = 50 * 1024 * 1024; // 50MB Telegram limit
        this.maxRetries = 3;
        this.retryDelay = 5000; // 5 seconds
    }

    async uploadVideo(videoPath, originalName, videoId) {
        if (!this.bot) {
            console.log('Telegram service not configured, skipping upload');
            return { uploaded: false, reason: 'Service not configured' };
        }

        // Verify file exists before attempting upload
        if (!await fs.pathExists(videoPath)) {
            console.error(`File not found for upload: ${videoPath}`);
            return { uploaded: false, reason: 'File not found' };
        }

        try {
            const stats = await fs.stat(videoPath);
            const fileSize = stats.size;
            
            console.log(`Starting Telegram upload: ${originalName} (${fileSize} bytes)`);

            // Skip checksum calculation for faster upload (can be done later if needed)
            let primaryResult;
            if (fileSize > this.maxFileSize) {
                console.log('File exceeds single upload limit, using chunked upload');
                primaryResult = await this.uploadLargeVideoWithRetry(videoPath, originalName, videoId, null);
            } else {
                console.log('Using single file upload');
                primaryResult = await this.uploadSmallVideoWithRetry(videoPath, originalName, videoId, null);
            }

            // Start backup uploads in background (don't wait for them)
            if (this.backupChannelIds.length > 0) {
                setImmediate(async () => {
                    const backupResults = [];
                    
                    // Check if file still exists before attempting backup uploads
                    const fileExists = await fs.pathExists(videoPath);
                    if (!fileExists) {
                        console.log('Original file already cleaned up, skipping backup uploads');
                        return;
                    }
                    
                    for (const channelId of this.backupChannelIds) {
                        try {
                            console.log(`Uploading backup to channel: ${channelId}`);
                            const backupResult = await this.uploadToChannel(videoPath, originalName, videoId, null, channelId);
                            backupResults.push({ channelId, ...backupResult });
                        } catch (error) {
                            console.warn(`Backup upload failed to ${channelId}:`, error.message);
                            backupResults.push({ channelId, uploaded: false, error: error.message });
                        }
                    }
                    console.log(`Backup uploads completed: ${backupResults.filter(b => b.uploaded).length}/${backupResults.length} successful`);
                });
            }

            return {
                ...primaryResult,
                redundancy: 1 + this.backupChannelIds.length // Potential redundancy
            };
        } catch (error) {
            console.error('Telegram upload error:', error);
            return { uploaded: false, error: error.message };
        }
    }

    async uploadSmallVideo(videoPath, originalName, videoId) {
        try {
            const caption = `📹 ${originalName}\n🆔 ${videoId}\n📅 ${new Date().toLocaleString()}`;
            
            // Create a read stream for the file
            const fileStream = fs.createReadStream(videoPath);
            
            const result = await this.bot.sendVideo(this.primaryChannelId, fileStream, {
                caption: caption,
                supports_streaming: true,
                filename: originalName
            }, {
                filename: originalName,
                contentType: 'video/mp4'
            });

            return {
                uploaded: true,
                messageId: result.message_id,
                fileId: result.video.file_id,
                fileUniqueId: result.video.file_unique_id,
                size: result.video.file_size,
                duration: result.video.duration,
                uploadMethod: 'single'
            };
        } catch (error) {
            console.error('Small video upload error:', error);
            throw error;
        }
    }

    async uploadLargeVideo(videoPath, originalName, videoId) {
        try {
            // For large files, split into chunks
            const chunkSize = 45 * 1024 * 1024; // 45MB chunks
            const chunks = await this.splitVideoFile(videoPath, chunkSize);
            const uploadedChunks = [];

            for (let i = 0; i < chunks.length; i++) {
                const chunkPath = chunks[i];
                const caption = `📹 ${originalName} (Part ${i + 1}/${chunks.length})\n🆔 ${videoId}\n📅 ${new Date().toLocaleString()}`;
                
                // Create a read stream for the chunk
                const chunkStream = fs.createReadStream(chunkPath);
                
                const result = await this.bot.sendDocument(this.primaryChannelId, chunkStream, {
                    caption: caption,
                    filename: `${originalName}.part${i + 1}`
                }, {
                    filename: `${originalName}.part${i + 1}`,
                    contentType: 'application/octet-stream'
                });

                uploadedChunks.push({
                    part: i + 1,
                    messageId: result.message_id,
                    fileId: result.document.file_id,
                    fileUniqueId: result.document.file_unique_id,
                    size: result.document.file_size
                });

                // Clean up chunk file
                await fs.remove(chunkPath);
            }

            return {
                uploaded: true,
                uploadMethod: 'chunked',
                totalChunks: chunks.length,
                chunks: uploadedChunks
            };
        } catch (error) {
            console.error('Large video upload error:', error);
            throw error;
        }
    }

    async splitVideoFile(videoPath, chunkSize) {
        const chunks = [];
        const fileSize = (await fs.stat(videoPath)).size;
        const numChunks = Math.ceil(fileSize / chunkSize);
        
        const tempDir = path.join(__dirname, '..', 'temp');
        await fs.ensureDir(tempDir);

        for (let i = 0; i < numChunks; i++) {
            const chunkPath = path.join(tempDir, `chunk_${i}.bin`);
            const start = i * chunkSize;
            const end = Math.min(start + chunkSize, fileSize);
            
            const readStream = fs.createReadStream(videoPath, { start, end: end - 1 });
            const writeStream = fs.createWriteStream(chunkPath);
            
            await new Promise((resolve, reject) => {
                readStream.pipe(writeStream);
                writeStream.on('finish', resolve);
                writeStream.on('error', reject);
            });

            chunks.push(chunkPath);
        }

        return chunks;
    }

    async downloadVideo(telegramData, outputPath) {
        if (!this.bot || !telegramData.uploaded) {
            throw new Error('Cannot download: Telegram service not available or video not uploaded');
        }

        try {
            if (telegramData.uploadMethod === 'single') {
                const fileStream = this.bot.getFileStream(telegramData.fileId);
                const writeStream = fs.createWriteStream(outputPath);
                
                return new Promise((resolve, reject) => {
                    fileStream.pipe(writeStream);
                    writeStream.on('finish', resolve);
                    writeStream.on('error', reject);
                });
            } else if (telegramData.uploadMethod === 'chunked') {
                return await this.downloadChunkedVideo(telegramData, outputPath);
            }
        } catch (error) {
            console.error('Download error:', error);
            throw error;
        }
    }

    async downloadChunkedVideo(telegramData, outputPath) {
        const tempDir = path.join(__dirname, '..', 'temp');
        await fs.ensureDir(tempDir);
        
        const writeStream = fs.createWriteStream(outputPath);
        
        for (const chunk of telegramData.chunks) {
            const chunkStream = this.bot.getFileStream(chunk.fileId);
            
            await new Promise((resolve, reject) => {
                chunkStream.on('data', (data) => {
                    writeStream.write(data);
                });
                chunkStream.on('end', resolve);
                chunkStream.on('error', reject);
            });
        }
        
        writeStream.end();
        
        return new Promise((resolve, reject) => {
            writeStream.on('finish', resolve);
            writeStream.on('error', reject);
        });
    }

    async deleteVideo(telegramData) {
        if (!this.bot || !telegramData.uploaded) {
            return { deleted: false, reason: 'Service not available or video not uploaded' };
        }

        try {
            if (telegramData.uploadMethod === 'single') {
                await this.bot.deleteMessage(this.channelId, telegramData.messageId);
            } else if (telegramData.uploadMethod === 'chunked') {
                for (const chunk of telegramData.chunks) {
                    await this.bot.deleteMessage(this.channelId, chunk.messageId);
                }
            }
            
            return { deleted: true };
        } catch (error) {
            console.error('Delete error:', error);
            return { deleted: false, error: error.message };
        }
    }

    // New utility methods
    async calculateChecksum(filePath) {
        const crypto = require('crypto');
        const hash = crypto.createHash('sha256');
        const stream = fs.createReadStream(filePath);
        
        return new Promise((resolve, reject) => {
            stream.on('data', data => hash.update(data));
            stream.on('end', () => resolve(hash.digest('hex')));
            stream.on('error', reject);
        });
    }

    async uploadWithRetry(uploadFunction, maxRetries = this.maxRetries) {
        for (let attempt = 1; attempt <= maxRetries; attempt++) {
            try {
                return await uploadFunction();
            } catch (error) {
                console.warn(`Upload attempt ${attempt} failed:`, error.message);
                if (attempt === maxRetries) {
                    throw error;
                }
                await this.sleep(this.retryDelay * attempt);
            }
        }
    }

    async uploadSmallVideoWithRetry(videoPath, originalName, videoId, checksum) {
        return await this.uploadWithRetry(() => 
            this.uploadToChannel(videoPath, originalName, videoId, checksum, this.primaryChannelId)
        );
    }

    async uploadLargeVideoWithRetry(videoPath, originalName, videoId, checksum) {
        return await this.uploadWithRetry(() => 
            this.uploadLargeVideoToChannel(videoPath, originalName, videoId, checksum, this.primaryChannelId)
        );
    }

    async uploadToChannel(videoPath, originalName, videoId, checksum, channelId) {
        const stats = await fs.stat(videoPath);
        const fileSize = stats.size;

        if (fileSize > this.maxFileSize) {
            return await this.uploadLargeVideoToChannel(videoPath, originalName, videoId, checksum, channelId);
        } else {
            return await this.uploadSmallVideoToChannel(videoPath, originalName, videoId, checksum, channelId);
        }
    }

    async uploadSmallVideoToChannel(videoPath, originalName, videoId, checksum, channelId) {
        const caption = checksum ? 
            `📹 ${originalName}\n🆔 ${videoId}\n📅 ${new Date().toLocaleString()}\n🔐 ${checksum.substring(0, 16)}...` :
            `📹 ${originalName}\n🆔 ${videoId}\n📅 ${new Date().toLocaleString()}`;
        
        // Create a read stream for the file
        const fileStream = fs.createReadStream(videoPath);
        
        const result = await this.bot.sendVideo(channelId, fileStream, {
            caption: caption,
            supports_streaming: true,
            filename: originalName
        }, {
            filename: originalName,
            contentType: 'video/mp4'
        });

        return {
            uploaded: true,
            channelId: channelId,
            messageId: result.message_id,
            fileId: result.video.file_id,
            fileUniqueId: result.video.file_unique_id,
            size: result.video.file_size,
            duration: result.video.duration,
            uploadMethod: 'single',
            checksum: checksum
        };
    }

    async uploadLargeVideoToChannel(videoPath, originalName, videoId, checksum, channelId) {
        // For large files, split into chunks
        const chunkSize = 45 * 1024 * 1024; // 45MB chunks
        const chunks = await this.splitVideoFile(videoPath, chunkSize);
        const uploadedChunks = [];

        for (let i = 0; i < chunks.length; i++) {
            const chunkPath = chunks[i];
            const caption = checksum ? 
                `📹 ${originalName} (Part ${i + 1}/${chunks.length})\n🆔 ${videoId}\n📅 ${new Date().toLocaleString()}\n🔐 ${checksum.substring(0, 16)}...` :
                `📹 ${originalName} (Part ${i + 1}/${chunks.length})\n🆔 ${videoId}\n📅 ${new Date().toLocaleString()}`;
            
            // Create a read stream for the chunk
            const chunkStream = fs.createReadStream(chunkPath);
            
            const result = await this.bot.sendDocument(channelId, chunkStream, {
                caption: caption,
                filename: `${originalName}.part${i + 1}`
            }, {
                filename: `${originalName}.part${i + 1}`,
                contentType: 'application/octet-stream'
            });

            uploadedChunks.push({
                part: i + 1,
                messageId: result.message_id,
                fileId: result.document.file_id,
                fileUniqueId: result.document.file_unique_id,
                size: result.document.file_size
            });

            // Clean up chunk file
            await fs.remove(chunkPath);
        }

        return {
            uploaded: true,
            channelId: channelId,
            uploadMethod: 'chunked',
            totalChunks: chunks.length,
            chunks: uploadedChunks,
            checksum: checksum
        };
    }

    async verifyUpload(telegramData, originalChecksum) {
        if (!telegramData.uploaded || !originalChecksum) {
            return { verified: false, reason: 'Upload data or checksum missing' };
        }

        try {
            // For verification, we check if the stored checksum matches
            const storedChecksum = telegramData.checksum;
            const verified = storedChecksum === originalChecksum;
            
            return {
                verified: verified,
                storedChecksum: storedChecksum,
                originalChecksum: originalChecksum,
                redundancy: telegramData.redundancy || 1
            };
        } catch (error) {
            return { verified: false, error: error.message };
        }
    }

    async getStorageHealth() {
        if (!this.bot) {
            return { healthy: false, reason: 'Service not configured' };
        }

        try {
            const channels = [this.primaryChannelId, ...this.backupChannelIds];
            const health = [];

            for (const channelId of channels) {
                try {
                    // Try to get channel info
                    const chat = await this.bot.getChat(channelId);
                    health.push({
                        channelId: channelId,
                        status: 'healthy',
                        title: chat.title,
                        type: chat.type
                    });
                } catch (error) {
                    health.push({
                        channelId: channelId,
                        status: 'unhealthy',
                        error: error.message
                    });
                }
            }

            const healthyCount = health.filter(h => h.status === 'healthy').length;
            
            return {
                healthy: healthyCount > 0,
                channels: health,
                redundancy: healthyCount,
                primaryHealthy: health[0]?.status === 'healthy'
            };
        } catch (error) {
            return { healthy: false, error: error.message };
        }
    }

    /**
     * Upload HLS segments and playlists to Telegram for complete cloud storage
     * @param {string} hlsDir - Directory containing HLS files
     * @param {string} videoId - Video identifier
     * @returns {Promise<Object>} Upload results
     */
    async uploadHLSFiles(hlsDir, videoId) {
        if (!this.bot || !await fs.pathExists(hlsDir)) {
            return { uploaded: false, reason: 'Service not configured or HLS directory not found' };
        }

        try {
            console.log(`Uploading HLS files from ${hlsDir}`);
            const hlsFiles = [];
            
            // Recursively find all HLS files
            const findHLSFiles = async (dir, relativePath = '') => {
                const files = await fs.readdir(dir);
                
                for (const file of files) {
                    const fullPath = path.join(dir, file);
                    const relativeFilePath = path.join(relativePath, file);
                    const stats = await fs.stat(fullPath);
                    
                    if (stats.isDirectory()) {
                        await findHLSFiles(fullPath, relativeFilePath);
                    } else if (file.endsWith('.m3u8') || file.endsWith('.ts')) {
                        hlsFiles.push({
                            fullPath,
                            relativePath: relativeFilePath,
                            size: stats.size
                        });
                    }
                }
            };
            
            await findHLSFiles(hlsDir);
            console.log(`Found ${hlsFiles.length} HLS files to upload`);
            
            if (hlsFiles.length === 0) {
                return { uploaded: false, reason: 'No HLS files found' };
            }
            
            // Check if we should skip HLS upload due to large number of files
            if (hlsFiles.length > 100) {
                console.log('Skipping HLS upload due to large number of files (>100) - would hit rate limits');
                return { 
                    uploaded: false, 
                    reason: 'Too many HLS files - would exceed Telegram rate limits',
                    totalFiles: hlsFiles.length,
                    recommendation: 'HLS files kept locally for streaming'
                };
            }
            
            // Upload files with rate limiting protection
            const uploadResults = [];
            const batchSize = 3; // Reduced batch size to avoid rate limiting
            const batchDelay = 3000; // 3 seconds between batches
            const retryDelay = 45000; // 45 seconds when rate limited
            
            for (let i = 0; i < hlsFiles.length; i += batchSize) {
                const batch = hlsFiles.slice(i, i + batchSize);
                console.log(`Uploading HLS batch ${Math.floor(i / batchSize) + 1}/${Math.ceil(hlsFiles.length / batchSize)}`);
                
                const batchPromises = batch.map(async (file) => {
                    let retries = 0;
                    const maxRetries = 3;
                    
                    while (retries < maxRetries) {
                        try {
                            const fileStream = fs.createReadStream(file.fullPath);
                            const caption = `📁 HLS: ${file.relativePath}\n🆔 ${videoId}\n📅 ${new Date().toLocaleString()}`;
                            
                            const result = await this.bot.sendDocument(this.primaryChannelId, fileStream, {
                                caption: caption,
                                filename: file.relativePath
                            });
                            
                            return {
                                relativePath: file.relativePath,
                                messageId: result.message_id,
                                fileId: result.document.file_id,
                                uploaded: true
                            };
                            
                        } catch (error) {
                            if (error.message.includes('429') || error.message.includes('Too Many Requests')) {
                                console.log(`Rate limited for ${file.relativePath}, waiting ${retryDelay}ms...`);
                                await this.sleep(retryDelay);
                                retries++;
                                if (retries < maxRetries) continue;
                            }
                            
                            console.warn(`Failed to upload HLS file ${file.relativePath}:`, error.message);
                            return {
                                relativePath: file.relativePath,
                                uploaded: false,
                                error: error.message
                            };
                        }
                    }
                });
                
                const batchResults = await Promise.all(batchPromises);
                uploadResults.push(...batchResults);
                
                // Longer delay between batches to avoid rate limiting
                if (i + batchSize < hlsFiles.length) {
                    console.log(`Waiting ${batchDelay}ms before next batch...`);
                    await this.sleep(batchDelay);
                }
            }
            
            const successfulUploads = uploadResults.filter(r => r.uploaded).length;
            console.log(`HLS upload completed: ${successfulUploads}/${hlsFiles.length} files uploaded`);
            
            return {
                uploaded: successfulUploads > 0,
                totalFiles: hlsFiles.length,
                successfulUploads,
                uploadResults,
                uploadMethod: 'hls-batch'
            };
            
        } catch (error) {
            console.error('HLS upload error:', error);
            return { uploaded: false, error: error.message };
        }
    }

    sleep(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }
}

module.exports = TelegramService;
