const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs-extra');
const cors = require('cors');
const { v4: uuidv4 } = require('uuid');
require('dotenv').config();

const TelegramService = require('./services/telegramService');
const VideoProcessor = require('./services/videoProcessor');
const DatabaseService = require('./services/databaseService');
const CloudStreamingService = require('./services/cloudStreamingService');

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json());

// Static files with cache control
app.use(express.static('public', {
    maxAge: 0, // Disable caching for development
    etag: false,
    setHeaders: (res, path) => {
        if (path.endsWith('.js') || path.endsWith('.css')) {
            res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
            res.setHeader('Pragma', 'no-cache');
            res.setHeader('Expires', '0');
        }
    }
}));

// Ensure directories exist
const ensureDirectories = async () => {
    const dirs = ['uploads', 'temp', 'data', 'hls'];
    for (const dir of dirs) {
        await fs.ensureDir(dir);
    }
};

// Configure multer for file uploads
const storage = multer.diskStorage({
    destination: (req, file, cb) => {
        cb(null, 'uploads/');
    },
    filename: (req, file, cb) => {
        const uniqueName = `${uuidv4()}-${file.originalname}`;
        cb(null, uniqueName);
    }
});

const upload = multer({
    storage: storage,
    limits: {
        fileSize: 10 * 1024 * 1024 * 1024 // 10GB limit - effectively unlimited for most videos
    },
    fileFilter: (req, file, cb) => {
        const allowedTypes = /\.(mp4|avi|mkv|mov|wmv|flv|webm|m4v|3gp)$/i;
        if (allowedTypes.test(file.originalname)) {
            cb(null, true);
        } else {
            cb(new Error('Invalid file type. Only video files are allowed.'));
        }
    }
});

// Initialize services
const telegramService = new TelegramService();
const videoProcessor = new VideoProcessor();
const databaseService = new DatabaseService();
const cloudStreamingService = new CloudStreamingService();

// Routes
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Upload video endpoint
app.post('/api/upload', upload.single('video'), async (req, res) => {
    const startTime = Date.now();
    
    try {
        if (!req.file) {
            return res.status(400).json({ error: 'No video file uploaded' });
        }

        const videoId = uuidv4();
        const videoPath = req.file.path;
        const originalName = req.file.originalname;

        console.log(`Processing video: ${originalName}`);

        // Get metadata first to detect audio tracks
        console.log('Extracting video metadata...');
        const metadata = await videoProcessor.getVideoMetadata(videoPath);
        
        // Extract audio track information from the video
        const detectedAudioTracks = metadata.audio.map((track, index) => ({
            index: index,
            language: track.language || 'unknown',
            title: track.title || `Audio Track ${index + 1}`,
            codec: track.codec,
            channels: track.channels,
            sampleRate: track.sampleRate
        }));
        
        console.log(`Detected ${detectedAudioTracks.length} audio tracks in video`);
        
        // Try to upload to Telegram, but don't fail if it doesn't work
        let telegramData = { uploaded: false };
        let uploadTime = 0;
        
        try {
            console.log('Attempting to upload to Telegram cloud storage...');
            const uploadStartTime = Date.now();
            telegramData = await telegramService.uploadVideo(videoPath, originalName, videoId);
            uploadTime = Date.now() - uploadStartTime;
            console.log(`Telegram upload completed in ${uploadTime}ms`);
        } catch (error) {
            console.warn('Telegram upload failed (non-critical):', error.message);
            // Continue without Telegram backup
        }

        // Save to database with detected audio tracks
        const videoData = {
            id: videoId,
            originalName: originalName,
            metadata: metadata,
            telegramData: telegramData,
            cloudThumbnail: null, // Will be generated in background
            uploadDate: new Date().toISOString(),
            size: req.file.size,
            viewCount: 0,
            favorite: false,
            tags: [],
            category: null,
            shareLinks: [],
            streamingMethod: 'cloud',
            uploadTime: uploadTime, // Track upload performance
            audioTracks: detectedAudioTracks, // Store detected audio track information
            hlsPlaylist: null, // Will be generated if requested
            processingStatus: {
                telegramUploading: false,
                hlsProgress: 0,
                thumbnailGenerating: false,
                complete: false,
                errors: []
            }
        };

        await databaseService.saveVideo(videoData);

        // Start background tasks (don't wait for them) - but keep file until background tasks complete
        setImmediate(async () => {
            try {
                // Update processing status to indicate thumbnail generation started
                await databaseService.updateVideoMetadata(videoId, {
                    processingStatus: {
                        telegramUploading: false,
                        hlsProgress: 0,
                        thumbnailGenerating: true,
                        complete: false,
                        errors: []
                    }
                });
                
                // Generate thumbnail locally before deleting the file
                let cloudThumbnail = null;
                try {
                    console.log('Generating thumbnail from local file...');
                    // Generate thumbnail from local file instead of Telegram
                    const thumbnailPath = path.join(__dirname, 'temp', `${videoId}_thumb.jpg`);
                    await videoProcessor.extractThumbnail(videoPath, thumbnailPath, '00:00:05');
                    
                    // Read thumbnail and store as base64
                    if (await fs.pathExists(thumbnailPath)) {
                        const thumbnailBuffer = await fs.readFile(thumbnailPath);
                        cloudThumbnail = {
                            data: thumbnailBuffer,
                            contentType: 'image/jpeg'
                        };
                        console.log('Thumbnail generated successfully from local file');
                        
                        // Clean up thumbnail file
                        await fs.remove(thumbnailPath);
                    }
                } catch (error) {
                    console.log('Local thumbnail generation failed (non-critical):', error.message.split('\n')[0]);
                    // Continue without thumbnail - not a critical error
                }

                // Update database with enhanced data and processing status
                if (cloudThumbnail) {
                    await databaseService.updateVideoMetadata(videoId, {
                        cloudThumbnail: cloudThumbnail,
                        processingStatus: {
                            telegramUploading: false,
                            hlsProgress: 0,
                            thumbnailGenerating: false,
                            complete: false,
                            errors: []
                        }
                    });
                } else {
                    await databaseService.updateVideoMetadata(videoId, {
                        processingStatus: {
                            telegramUploading: false,
                            hlsProgress: 0,
                            thumbnailGenerating: false,
                            complete: false,
                            errors: []
                        }
                    });
                }
                
                // Process video with multi-audio support
                try {
                    console.log('Processing video with multi-audio support...');
                    
                    // Create progress callback with quality information
                    const progressCallback = async (progress, stage, currentQuality = null) => {
                        console.log(`Processing Progress: ${progress}% - ${stage}`);
                        await databaseService.updateVideoMetadata(videoId, {
                            processingStatus: {
                                telegramUploading: false,
                                hlsProgress: progress,
                                hlsStage: stage,
                                currentQuality: currentQuality,
                                thumbnailGenerating: false,
                                complete: progress >= 100,
                                errors: []
                            }
                        }).catch(err => console.warn('Failed to update processing progress:', err));
                    };
                    
                    // Use multi-audio processing for videos with multiple audio tracks
                    const hasMultipleAudio = metadata.audio && metadata.audio.length > 1;
                    let processingResults;
                    
                    if (hasMultipleAudio) {
                        console.log(`Video has ${metadata.audio.length} audio tracks - using multi-audio processing`);
                        processingResults = await videoProcessor.processMultiAudioVideo(videoPath, videoId, metadata, progressCallback);
                    } else {
                        console.log('Video has single audio track - using standard processing');
                        const hlsPath = await videoProcessor.convertToHLSWithProgress(videoPath, videoId, metadata, progressCallback);
                        processingResults = {
                            hlsPath: hlsPath,
                            extractedAudioFiles: [],
                            audioHLSStreams: [],
                            videoOnlyHLS: null,
                            hasMultiAudio: false
                        };
                    }
                    
                    // Prepare audio files for cloud upload if they exist
                    let audioCloudData = [];
                    if (processingResults.extractedAudioFiles.length > 0) {
                        console.log(`Starting audio file cloud uploads for ${processingResults.extractedAudioFiles.length} tracks...`);
                        
                        // Check if main video upload failed, if so, skip audio uploads to avoid further delays
                        const skipAudioUploads = !telegramData.uploaded;
                        if (skipAudioUploads) {
                            console.log('Main video upload failed, skipping audio file uploads to prevent delays');
                            audioCloudData = processingResults.extractedAudioFiles.map(audioFile => ({
                                ...audioFile,
                                telegramData: { uploaded: false, error: 'Skipped due to main video upload failure' },
                                hlsUrl: processingResults.audioHLSStreams.find(s => s.trackIndex === audioFile.trackIndex)?.hlsPlaylistUrl || null
                            }));
                        } else {
                        
                        // Upload audio files with timeout and error handling
                        const audioUploadPromises = processingResults.extractedAudioFiles.map(async (audioFile, index) => {
                            try {
                                console.log(`Uploading audio track ${audioFile.trackIndex} (${index + 1}/${processingResults.extractedAudioFiles.length})...`);
                                
                                // Add timeout for audio uploads (30 seconds per file)
                                const uploadPromise = telegramService.uploadVideo(
                                    audioFile.filePath, 
                                    audioFile.fileName, 
                                    `${videoId}_audio_${audioFile.trackIndex}`
                                );
                                
                                const timeoutPromise = new Promise((_, reject) => 
                                    setTimeout(() => reject(new Error('Upload timeout after 30 seconds')), 30000)
                                );
                                
                                const audioTelegramData = await Promise.race([uploadPromise, timeoutPromise]);
                                
                                console.log(`Audio track ${audioFile.trackIndex} uploaded successfully`);
                                return {
                                    ...audioFile,
                                    telegramData: audioTelegramData,
                                    hlsUrl: processingResults.audioHLSStreams.find(s => s.trackIndex === audioFile.trackIndex)?.hlsPlaylistUrl || null
                                };
                            } catch (error) {
                                console.warn(`Failed to upload audio track ${audioFile.trackIndex}:`, error.message);
                                return {
                                    ...audioFile,
                                    telegramData: { uploaded: false, error: error.message },
                                    hlsUrl: processingResults.audioHLSStreams.find(s => s.trackIndex === audioFile.trackIndex)?.hlsPlaylistUrl || null
                                };
                            }
                        });
                        
                        // Wait for all audio uploads to complete (with timeout)
                        try {
                            const allUploadsTimeout = new Promise((_, reject) => 
                                setTimeout(() => reject(new Error('All audio uploads timeout after 5 minutes')), 300000)
                            );
                            
                            audioCloudData = await Promise.race([
                                Promise.all(audioUploadPromises),
                                allUploadsTimeout
                            ]);
                            
                            const successfulUploads = audioCloudData.filter(a => a.telegramData?.uploaded).length;
                            console.log(`Audio uploads completed: ${successfulUploads}/${audioCloudData.length} successful`);
                        } catch (error) {
                            console.error('Audio uploads timed out or failed:', error.message);
                            // Use whatever uploads completed so far
                            audioCloudData = await Promise.allSettled(audioUploadPromises).then(results => 
                                results.map((result, index) => {
                                    if (result.status === 'fulfilled') {
                                        return result.value;
                                    } else {
                                        return {
                                            ...processingResults.extractedAudioFiles[index],
                                            telegramData: { uploaded: false, error: result.reason.message },
                                            hlsUrl: processingResults.audioHLSStreams.find(s => s.trackIndex === processingResults.extractedAudioFiles[index].trackIndex)?.hlsPlaylistUrl || null
                                        };
                                    }
                                })
                            );
                        }
                        } // Close skipAudioUploads else block
                    }
                    
                    // Update database with complete processing results
                    await databaseService.updateVideoMetadata(videoId, {
                        hlsPlaylist: processingResults.hlsPath,
                        videoOnlyHLS: processingResults.videoOnlyHLS,
                        extractedAudioFiles: audioCloudData,
                        audioHLSStreams: processingResults.audioHLSStreams,
                        hasMultiAudio: processingResults.hasMultiAudio,
                        streamingMethod: processingResults.hasMultiAudio ? 'multi-audio-adaptive' : 'adaptive',
                        processingStatus: {
                            telegramUploading: false,
                            hlsProgress: 100,
                            hlsStage: 'Processing complete',
                            currentQuality: null,
                            thumbnailGenerating: false,
                            complete: true, // Mark as complete
                            errors: []
                        }
                    });
                    
                    console.log('Multi-audio processing complete - video will stream with separate audio tracks');
                    
                    // Upload HLS files to Telegram for complete cloud storage (optional)
                    if (processingResults.hlsPath && telegramData.uploaded) {
                        try {
                            console.log('Uploading HLS segments to Telegram (if feasible)...');
                            const hlsDir = path.dirname(processingResults.hlsPath);
                            const hlsUploadResult = await telegramService.uploadHLSFiles(hlsDir, videoId);
                            
                            // Update database with HLS cloud data
                            await databaseService.updateVideoMetadata(videoId, {
                                hlsCloudData: hlsUploadResult
                            });
                            
                            if (hlsUploadResult.uploaded) {
                                console.log(`✅ HLS files uploaded to Telegram: ${hlsUploadResult.successfulUploads}/${hlsUploadResult.totalFiles}`);
                            } else {
                                console.log(`⚠️ HLS upload skipped: ${hlsUploadResult.reason || hlsUploadResult.error}`);
                                console.log('💡 HLS files will remain locally for streaming - this is normal for large files');
                            }
                        } catch (hlsError) {
                            console.log(`⚠️ HLS upload to Telegram failed: ${hlsError.message}`);
                            console.log('💡 HLS files will remain locally for streaming - video will work normally');
                        }
                    }
                    
                    // Clean up extracted audio files after successful upload
                    if (processingResults.extractedAudioFiles.length > 0) {
                        await videoProcessor.audioExtractor.cleanupAudioFiles(processingResults.extractedAudioFiles);
                        console.log('Cleaned up temporary audio files');
                    }
                    
                } catch (error) {
                    console.warn('Video processing failed, falling back to direct streaming:', error.message);
                    // Even if processing fails, video can still be streamed directly
                    await databaseService.updateVideoMetadata(videoId, {
                        processingStatus: {
                            telegramUploading: false,
                            hlsProgress: 0,
                            thumbnailGenerating: false,
                            complete: false,
                            errors: [`Video processing failed: ${error.message}`]
                        }
                    }).catch(err => console.warn('Failed to update processing error status:', err));
                }

                // Processing completion is now handled in the main processing block above
                
                // Clean up local files intelligently after processing is complete
                console.log('Performing intelligent cleanup of local files...');
                
                // Only clean up if Telegram upload was successful or if explicitly configured
                const forceCleanup = process.env.FORCE_CLEANUP === 'true';
                const telegramSuccess = telegramData.uploaded;
                
                if (telegramSuccess || forceCleanup) {
                    console.log('Starting cleanup (Telegram upload successful)...');
                    let cleanedFiles = 0;
                    
                    // Clean up original video file
                    if (await fs.pathExists(videoPath)) {
                        await fs.remove(videoPath).catch(err => console.warn('Failed to cleanup video:', err));
                        console.log(`✓ Cleaned up original video: ${videoPath}`);
                        cleanedFiles++;
                    }
                    
                    // Only clean up HLS files if they were successfully uploaded to Telegram
                    const video = await databaseService.getVideo(videoId);
                    const hlsUploadedSuccessfully = video.hlsCloudData?.uploaded;
                    
                    if (hlsUploadedSuccessfully || forceCleanup) {
                        const videoHlsDir = path.join(__dirname, 'hls', videoId);
                        if (await fs.pathExists(videoHlsDir)) {
                            await fs.remove(videoHlsDir).catch(err => console.warn('Failed to cleanup HLS:', err));
                            console.log(`✓ Cleaned up HLS directory: ${videoHlsDir}`);
                            cleanedFiles++;
                        }
                    } else {
                        console.log(`💾 Keeping HLS files locally (not uploaded to Telegram)`);
                    }
                    
                    // Clean up any temporary audio files that might remain
                    const audioDir = path.join(__dirname, 'audio', videoId);
                    if (await fs.pathExists(audioDir)) {
                        await fs.remove(audioDir).catch(err => console.warn('Failed to cleanup audio:', err));
                        console.log(`✓ Cleaned up audio directory: ${audioDir}`);
                        cleanedFiles++;
                    }
                    
                    // Clean up any temporary thumbnail files
                    const tempDir = path.join(__dirname, 'temp');
                    if (await fs.pathExists(tempDir)) {
                        const tempFiles = await fs.readdir(tempDir).catch(() => []);
                        const videoTempFiles = tempFiles.filter(file => file.includes(videoId));
                        
                        for (const tempFile of videoTempFiles) {
                            const tempFilePath = path.join(tempDir, tempFile);
                            await fs.remove(tempFilePath).catch(err => console.warn(`Failed to cleanup temp file ${tempFile}:`, err));
                            console.log(`✓ Cleaned up temp file: ${tempFile}`);
                            cleanedFiles++;
                        }
                    }
                    
                    console.log(`✅ Cleanup completed: ${cleanedFiles} items removed. All files stored in Telegram cloud.`);
                } else {
                    console.log('⚠️  Keeping local files as backup since Telegram upload failed');
                    console.log('💡 Files will be cleaned up when Telegram storage becomes available');
                }
                
            } catch (error) {
                console.warn('Background processing failed:', error.message);
                // Mark processing as failed
                await databaseService.updateVideoMetadata(videoId, {
                    processingStatus: {
                        telegramUploading: false,
                        hlsProgress: 0,
                        thumbnailGenerating: false,
                        complete: true, // Mark as complete even if failed to stop further processing
                        errors: [`Background processing failed: ${error.message}`]
                    }
                }).catch(err => console.warn('Failed to mark processing failed:', err));
                
                // Clean up files based on upload success even if background processing fails
                const cleanupLocalFiles = telegramData.uploaded || process.env.FORCE_CLEANUP === 'true';
                
                if (cleanupLocalFiles) {
                    await fs.remove(videoPath).catch(err => console.warn('Failed to cleanup file:', err));
                    console.log('Local file cleaned up after processing failure');
                } else {
                    console.log('Keeping local file as backup due to upload failure and processing error');
                }
            }
        });

        const totalTime = Date.now() - startTime;
        console.log(`Total request processed in ${totalTime}ms (Upload: ${uploadTime}ms)`);

        // Return response immediately
        res.json({
            success: true,
            videoId: videoId,
            message: 'Video uploaded to cloud storage successfully',
            streamUrl: `/api/stream/${videoId}`,
            cloudStreamUrl: `/api/cloud-stream/${videoId}`,
            thumbnailUrl: `/api/thumbnail/${videoId}`, // Will be available once generated
            metadata: metadata,
            streamingMethod: 'cloud',
            processing: true, // Indicates background processing is ongoing
            performance: {
                uploadTime: uploadTime,
                totalTime: totalTime
            }
        });

    } catch (error) {
        console.error('Upload error:', error);
        res.status(500).json({ error: error.message });
    }
});

// Get video list
app.get('/api/videos', async (req, res) => {
    try {
        const videos = await databaseService.getAllVideos();
        console.log(`Found ${videos.length} videos in database`);
        res.json(videos);
    } catch (error) {
        console.error('Error fetching videos:', error);
        res.status(500).json({ error: error.message });
    }
});

// Debug endpoint
app.get('/api/debug', async (req, res) => {
    try {
        const videos = await databaseService.getAllVideos();
        const videoIds = videos.map(v => v.id);
        res.json({
            totalVideos: videos.length,
            videoIds: videoIds,
            sampleVideo: videos[0] || null
        });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Get video details
app.get('/api/video/:id', async (req, res) => {
    try {
        console.log('Fetching video with ID:', req.params.id);
        const video = await databaseService.getVideo(req.params.id);
        console.log('Video found:', video ? 'Yes' : 'No');
        if (!video) {
            return res.status(404).json({ error: 'Video not found' });
        }
        res.json(video);
    } catch (error) {
        console.error('Error fetching video:', error);
        res.status(500).json({ error: error.message });
    }
});

// Serve individual audio files for multi-audio videos
app.get('/api/audio/:videoId/:trackIndex', async (req, res) => {
    try {
        const { videoId, trackIndex } = req.params;
        const parsedTrackIndex = parseInt(trackIndex);
        console.log(`Audio request for video ${videoId}, track ${parsedTrackIndex}`);
        
        const video = await databaseService.getVideo(videoId);
        
        if (!video) {
            console.log(`Video not found: ${videoId}`);
            return res.status(404).json({ error: 'Video not found' });
        }
        
        // Find the specific audio track
        const audioTrack = video.extractedAudioFiles?.find(track => 
            track.trackIndex === parsedTrackIndex
        );
        
        if (!audioTrack) {
            console.log(`Audio track ${parsedTrackIndex} not found for video ${videoId}`);
            console.log('Available tracks:', video.extractedAudioFiles?.map(t => t.trackIndex));
            return res.status(404).json({ error: 'Audio track not found' });
        }
        
        console.log(`Found audio track: ${audioTrack.fileName}, Telegram uploaded: ${audioTrack.telegramData?.uploaded}`);
        
        // Set CORS headers for cross-origin requests
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
        res.setHeader('Access-Control-Allow-Headers', 'Range');
        
        // Stream from cloud if available
        if (audioTrack.telegramData?.uploaded && cloudStreamingService) {
            try {
                console.log(`Streaming audio track ${parsedTrackIndex} from Telegram cloud`);
                const streamResult = await cloudStreamingService.streamVideo(
                    audioTrack.telegramData,
                    req.headers.range,
                    audioTrack.fileName
                );
                
                // Set headers for audio streaming
                res.setHeader('Content-Type', 'audio/aac');
                res.setHeader('Accept-Ranges', 'bytes');
                res.setHeader('Cache-Control', 'no-cache');
                
                if (streamResult.range && req.headers.range) {
                    res.status(206);
                    res.setHeader('Content-Range', `bytes ${streamResult.range}/${streamResult.contentLength}`);
                } else {
                    res.setHeader('Content-Length', streamResult.contentLength);
                }
                
                // Handle stream errors with fallback
                streamResult.stream.on('error', (streamError) => {
                    console.error(`Audio stream error for track ${parsedTrackIndex}:`, streamError);
                    if (!res.headersSent) {
                        console.log('Attempting HLS fallback due to stream error');
                        // Try HLS fallback instead of returning error
                        if (audioTrack.hlsUrl) {
                            return res.redirect(audioTrack.hlsUrl);
                        } else {
                            return res.status(500).json({ error: 'Stream interrupted and no fallback available' });
                        }
                    }
                });
                
                streamResult.stream.pipe(res);
                return;
                
            } catch (streamError) {
                console.error('Audio streaming from cloud failed:', streamError.message);
                console.log('Attempting HLS fallback due to cloud streaming failure');
                // Continue to try HLS fallback
            }
        }
        
        // Fallback to HLS URL if available
        if (audioTrack.hlsUrl) {
            console.log(`Redirecting to HLS for audio track ${parsedTrackIndex}: ${audioTrack.hlsUrl}`);
            return res.redirect(audioTrack.hlsUrl);
        }
        
        // Final fallback - try serving from local HLS if it exists
        const hlsDir = path.join(__dirname, 'hls', videoId, 'audio', `track_${parsedTrackIndex}`);
        const playlistPath = path.join(hlsDir, 'playlist.m3u8');
        
        if (await fs.pathExists(playlistPath)) {
            console.log(`Serving local HLS playlist for audio track ${parsedTrackIndex}`);
            return res.redirect(`/api/hls/${videoId}/audio/track_${parsedTrackIndex}/playlist.m3u8`);
        }
        
        // Last resort - check if there's a fallback audio stream available
        if (video.hlsPlaylist) {
            console.log(`Redirecting to main video HLS as last resort for audio track ${parsedTrackIndex}`);
            return res.redirect(`/api/hls/${videoId}/playlist.m3u8`);
        }
        
        console.log(`No audio source available for track ${parsedTrackIndex}`);
        return res.status(404).json({ 
            error: 'Audio stream not available', 
            message: `Track ${parsedTrackIndex} is not accessible. Try refreshing or selecting a different audio track.`
        });
        
    } catch (error) {
        console.error('Error serving audio:', error);
        res.status(500).json({ error: error.message });
    }
});

// Get video audio tracks information
app.get('/api/video/:id/audio-tracks', async (req, res) => {
    try {
        const videoId = req.params.id;
        const video = await databaseService.getVideo(videoId);
        
        if (!video) {
            return res.status(404).json({ error: 'Video not found' });
        }
        
        const audioTracks = {
            hasMultiAudio: video.hasMultiAudio || false,
            streamingMethod: video.streamingMethod,
            tracks: video.extractedAudioFiles || [],
            audioHLSStreams: video.audioHLSStreams || [],
            videoOnlyHLS: video.videoOnlyHLS || null,
            originalAudioTracks: video.audioTracks || []
        };
        
        console.log(`Audio tracks info for ${videoId}:`, audioTracks);
        res.json(audioTracks);
        
    } catch (error) {
        console.error('Error fetching audio tracks:', error);
        res.status(500).json({ error: error.message });
    }
});

// Get video processing status
app.get('/api/video/:id/status', async (req, res) => {
    try {
        const videoId = req.params.id;
        const video = await databaseService.getVideo(videoId);
        
        if (!video) {
            return res.status(404).json({ error: 'Video not found' });
        }
        
        // Check various processing states
        const hlsComplete = video.hlsPlaylist && (video.streamingMethod === 'adaptive' || video.streamingMethod === 'multi-audio-adaptive');
        const thumbnailComplete = video.cloudThumbnail !== null;
        const processingComplete = video.processingStatus?.complete === true;
        
        const status = {
            videoId: videoId,
            telegramUploaded: video.telegramData?.uploaded || false,
            telegramUploading: video.processingStatus?.telegramUploading || false,
            hlsComplete: hlsComplete,
            hlsProgress: video.processingStatus?.hlsProgress || 0,
            hlsStage: video.processingStatus?.hlsStage || 'Starting...',
            currentQuality: video.processingStatus?.currentQuality || null,
            thumbnailComplete: thumbnailComplete,
            thumbnailGenerating: video.processingStatus?.thumbnailGenerating || false,
            processingComplete: processingComplete,
            processingErrors: video.processingStatus?.errors || [],
            // Additional debug info
            hasHlsPlaylist: !!video.hlsPlaylist,
            streamingMethod: video.streamingMethod,
            hasThumbnail: !!video.cloudThumbnail
        };
        
        console.log(`Processing status for ${videoId}:`, status);
        res.json(status);
    } catch (error) {
        console.error('Error fetching processing status:', error);
        res.status(500).json({ error: error.message });
    }
});

// Direct cloud streaming endpoint
app.get('/api/stream/:id', async (req, res) => {
    try {
        const videoId = req.params.id;
        console.log(`Stream request for video ID: ${videoId}`);
        const video = await databaseService.getVideo(videoId);
        
        if (!video) {
            console.log(`Video not found: ${videoId}`);
            return res.status(404).json({ error: 'Video not found' });
        }

        // Check if video is available for streaming
        if (!video.telegramData?.uploaded) {
            console.log(`Video not uploaded to Telegram: ${videoId}`);
            
            // If HLS is available, redirect to HLS endpoint
            if (video.hlsPlaylist || video.streamingMethod === 'adaptive') {
                console.log(`Redirecting to HLS streaming for video: ${videoId}`);
                return res.redirect(`/api/hls/${videoId}/playlist.m3u8`);
            }
            
            return res.status(404).json({ error: 'Video not available for streaming' });
        }
        
        // For very large chunked files that cause Telegram issues, redirect to HLS
        if (video.telegramData?.uploadMethod === 'chunked' && video.size > 100 * 1024 * 1024) { // > 100MB
            console.log(`Large chunked video (${video.size} bytes), redirecting to HLS for better performance`);
            if (video.hlsPlaylist || video.streamingMethod === 'adaptive') {
                return res.redirect(`/api/hls/${videoId}/playlist.m3u8`);
            }
        }

        console.log(`Video found: ${video.originalName}, Telegram data:`, video.telegramData);

        // Increment view count
        await databaseService.incrementViewCount(videoId);

        // Parse range header for partial content requests
        const range = req.headers.range;
        console.log(`Range header: ${range}`);
        
        // Stream video directly from Telegram
        const streamData = await cloudStreamingService.streamVideo(video.telegramData, range, video.originalName);
        console.log(`Stream data obtained, content length: ${streamData.contentLength}`);
        
        // Set appropriate headers for browser video playback
        res.setHeader('Content-Type', streamData.contentType);
        res.setHeader('Accept-Ranges', streamData.acceptsRanges ? 'bytes' : 'none');
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
        res.setHeader('Access-Control-Allow-Headers', 'Range');
        res.setHeader('Cache-Control', 'no-cache');
        res.setHeader('Content-Disposition', `inline; filename="${encodeURIComponent(video.originalName)}"`);
        
        // Handle range requests
        if (range && streamData.acceptsRanges) {
            const parts = range.replace(/bytes=/, "").split("-");
            const start = parseInt(parts[0], 10);
            const end = parts[1] ? parseInt(parts[1], 10) : streamData.contentLength - 1;
            const chunkSize = (end - start) + 1;
            
            res.status(206);
            res.setHeader('Content-Range', `bytes ${start}-${end}/${streamData.contentLength}`);
            res.setHeader('Content-Length', chunkSize);
        } else if (!range) {
            // No range request, send full content
            res.setHeader('Content-Length', streamData.contentLength);
        }
        
        // Pipe the stream to response
        streamData.stream.pipe(res);
        
        streamData.stream.on('error', (error) => {
            console.error('Streaming error:', error);
            if (!res.headersSent) {
                res.status(500).json({ error: 'Streaming failed' });
            }
        });
        
    } catch (error) {
        console.error('Stream error:', error);
        if (!res.headersSent) {
            res.status(500).json({ error: error.message });
        }
    }
});

// Cloud streaming endpoint with better range support
app.get('/api/cloud-stream/:id', async (req, res) => {
    try {
        const videoId = req.params.id;
        const video = await databaseService.getVideo(videoId);
        
        if (!video) {
            return res.status(404).json({ error: 'Video not found' });
        }

        if (!video.telegramData?.uploaded) {
            return res.status(404).json({ error: 'Video not available for streaming' });
        }

        // Get stream info
        const streamInfo = await cloudStreamingService.getVideoStreamInfo(video.telegramData);
        
        // Stream the video with proper headers
        const streamData = await cloudStreamingService.streamVideo(video.telegramData, req.headers.range, video.originalName);
        
        // Set video-specific headers
        res.setHeader('Content-Type', streamData.contentType);
        res.setHeader('Content-Length', streamInfo.size);
        res.setHeader('Accept-Ranges', streamInfo.supportsRangeRequests ? 'bytes' : 'none');
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
        res.setHeader('Access-Control-Allow-Headers', 'Range');
        res.setHeader('Cache-Control', 'no-cache');
        res.setHeader('Content-Disposition', `inline; filename="${encodeURIComponent(video.originalName)}"`);        

        streamData.stream.pipe(res);
        
    } catch (error) {
        console.error('Cloud stream error:', error);
        res.status(500).json({ error: error.message });
    }
});

// Serve HLS playlists and segments
app.get('/api/hls/:videoId/*', async (req, res) => {
    try {
        const videoId = req.params.videoId;
        const requestPath = req.params[0] || 'playlist.m3u8';
        
        const video = await databaseService.getVideo(videoId);
        if (!video) {
            return res.status(404).json({ error: 'Video not found' });
        }
        
        const hlsDir = path.join(__dirname, 'hls', videoId);
        const filePath = path.join(hlsDir, requestPath);
        
        // Security check to prevent directory traversal
        if (!filePath.startsWith(hlsDir)) {
            return res.status(403).json({ error: 'Forbidden' });
        }
        
        // Check if file exists
        if (!await fs.pathExists(filePath)) {
            console.log(`HLS file not found: ${filePath}`);
            
            // For audio track requests, try to redirect to main video stream
            if (requestPath.includes('audio/track_')) {
                console.log('Audio HLS file missing, redirecting to main video stream');
                return res.redirect(`/api/hls/${videoId}/playlist.m3u8`);
            }
            
            // If main HLS files don't exist, try to serve from Telegram if available
            if (requestPath === 'playlist.m3u8') {
                console.log('Main HLS playlist missing, checking Telegram streaming');
                return res.redirect(`/api/stream/${videoId}`);
            }
            
            // For other missing files, try to find alternative or return helpful error
            return res.status(404).json({ 
                error: 'HLS file not found',
                message: 'The requested streaming segment is not available. This may be due to cleanup or processing issues.',
                suggestion: 'Try refreshing the page or using direct video streaming.'
            });
        }
        
        // Set appropriate content type
        let contentType = 'application/octet-stream';
        if (filePath.endsWith('.m3u8')) {
            contentType = 'application/vnd.apple.mpegurl';
        } else if (filePath.endsWith('.ts')) {
            contentType = 'video/mp2t';
        }
        
        // Set headers
        res.setHeader('Content-Type', contentType);
        res.setHeader('Cache-Control', 'no-cache');
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
        res.setHeader('Access-Control-Allow-Headers', 'Range');
        
        // Stream the file
        const stream = fs.createReadStream(filePath);
        stream.pipe(res);
        
    } catch (error) {
        console.error('HLS serving error:', error);
        res.status(500).json({ error: error.message });
    }
});

// Serve cloud-generated thumbnails
app.get('/api/thumbnail/:id', async (req, res) => {
    try {
        const videoId = req.params.id;
        const video = await databaseService.getVideo(videoId);
        
        if (!video || !video.cloudThumbnail) {
            return res.status(404).json({ error: 'Thumbnail not found' });
        }
        
        res.setHeader('Content-Type', video.cloudThumbnail.contentType);
        res.setHeader('Cache-Control', 'public, max-age=86400'); // 24 hours
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.send(video.cloudThumbnail.data);
        
    } catch (error) {
        console.error('Thumbnail error:', error);
        res.status(500).json({ error: error.message });
    }
});

// Rename video endpoint
app.put('/api/video/:id/rename', async (req, res) => {
    try {
        const videoId = req.params.id;
        const { newName } = req.body;
        
        if (!newName || typeof newName !== 'string' || !newName.trim()) {
            return res.status(400).json({ error: 'Invalid video name' });
        }

        const video = await databaseService.getVideo(videoId);
        if (!video) {
            return res.status(404).json({ error: 'Video not found' });
        }

        // Update video name in database
        await databaseService.updateVideoName(videoId, newName.trim());

        console.log(`Video ${videoId} renamed from '${video.originalName}' to '${newName.trim()}'`);
        res.json({ success: true, message: 'Video renamed successfully', newName: newName.trim() });
    } catch (error) {
        console.error('Rename error:', error);
        res.status(500).json({ error: error.message });
    }
});

// Delete video endpoint
app.delete('/api/video/:id', async (req, res) => {
    try {
        const videoId = req.params.id;
        const video = await databaseService.getVideo(videoId);
        
        if (!video) {
            return res.status(404).json({ error: 'Video not found' });
        }

        // Delete from Telegram (optional - videos remain in cloud for redundancy)
        try {
            if (video.telegramData?.uploaded) {
                console.log(`Video deleted from database. Telegram backup remains for recovery.`);
                // Uncomment the line below to also delete from Telegram
                // await telegramService.deleteVideo(video.telegramData);
            }
        } catch (error) {
            console.warn('Failed to delete from Telegram:', error.message);
        }

        // Delete from database
        await databaseService.deleteVideo(videoId);

        res.json({ success: true, message: 'Video deleted successfully' });
    } catch (error) {
        console.error('Delete error:', error);
        res.status(500).json({ error: error.message });
    }
});

// Enhanced video management endpoints

// Add tags to video
app.post('/api/video/:id/tags', async (req, res) => {
    try {
        const videoId = req.params.id;
        const { tags } = req.body;
        
        if (!tags || !Array.isArray(tags)) {
            return res.status(400).json({ error: 'Tags must be an array' });
        }
        
        const updatedTags = await databaseService.addVideoTags(videoId, tags);
        res.json({ success: true, tags: updatedTags });
    } catch (error) {
        console.error('Add tags error:', error);
        res.status(500).json({ error: error.message });
    }
});

// Set video category
app.put('/api/video/:id/category', async (req, res) => {
    try {
        const videoId = req.params.id;
        const { category } = req.body;
        
        await databaseService.setVideoCategory(videoId, category);
        res.json({ success: true, category });
    } catch (error) {
        console.error('Set category error:', error);
        res.status(500).json({ error: error.message });
    }
});

// Toggle favorite status
app.post('/api/video/:id/favorite', async (req, res) => {
    try {
        const videoId = req.params.id;
        const favorite = await databaseService.toggleFavorite(videoId);
        res.json({ success: true, favorite });
    } catch (error) {
        console.error('Toggle favorite error:', error);
        res.status(500).json({ error: error.message });
    }
});

// Increment view count
app.post('/api/video/:id/view', async (req, res) => {
    try {
        const videoId = req.params.id;
        const viewCount = await databaseService.incrementViewCount(videoId);
        res.json({ success: true, viewCount });
    } catch (error) {
        console.error('View count error:', error);
        res.status(500).json({ error: error.message });
    }
});

// Advanced search endpoint
app.post('/api/search', async (req, res) => {
    try {
        const searchResult = await databaseService.advancedSearch(req.body);
        res.json(searchResult);
    } catch (error) {
        console.error('Search error:', error);
        res.status(500).json({ error: error.message });
    }
});

// Generate sharing link
app.post('/api/video/:id/share', async (req, res) => {
    try {
        const videoId = req.params.id;
        const { expiresInHours = 24 } = req.body;
        
        const shareId = await databaseService.generateSharingLink(videoId, expiresInHours);
        res.json({ 
            success: true, 
            shareId,
            shareUrl: `${req.protocol}://${req.get('host')}/share/${shareId}`,
            expiresInHours
        });
    } catch (error) {
        console.error('Share link error:', error);
        res.status(500).json({ error: error.message });
    }
});

// Access shared video
app.get('/share/:shareId', async (req, res) => {
    try {
        const shareId = req.params.shareId;
        const shareData = await databaseService.getVideoByShareId(shareId);
        
        if (!shareData) {
            return res.status(404).json({ error: 'Shared video not found or expired' });
        }
        
        res.json({
            video: shareData.video,
            streamUrl: `/api/stream/${shareData.videoId}`,
            shareInfo: shareData.shareLink
        });
    } catch (error) {
        console.error('Shared video error:', error);
        res.status(500).json({ error: error.message });
    }
});

// Storage health check
app.get('/api/storage/health', async (req, res) => {
    try {
        const health = await telegramService.getStorageHealth();
        res.json(health);
    } catch (error) {
        console.error('Storage health error:', error);
        res.status(500).json({ error: error.message });
    }
});

// Video statistics endpoint
app.get('/api/stats', async (req, res) => {
    try {
        const stats = await databaseService.getVideoStats();
        res.json(stats);
    } catch (error) {
        console.error('Stats error:', error);
        res.status(500).json({ error: error.message });
    }
});

// Cleanup endpoint to remove local files
app.post('/api/cleanup', async (req, res) => {
    try {
        const cleanupResults = {
            uploads: { cleaned: 0, errors: 0 },
            temp: { cleaned: 0, errors: 0 },
            hls: { cleaned: 0, errors: 0 }
        };

        // Clean uploads directory
        try {
            const uploadFiles = await fs.readdir('uploads');
            for (const file of uploadFiles) {
                try {
                    await fs.remove(path.join('uploads', file));
                    cleanupResults.uploads.cleaned++;
                    console.log(`Cleaned upload file: ${file}`);
                } catch (error) {
                    cleanupResults.uploads.errors++;
                    console.warn(`Failed to clean upload file ${file}:`, error.message);
                }
            }
        } catch (error) {
            console.warn('Failed to read uploads directory:', error.message);
        }

        // Clean temp directory
        try {
            const tempFiles = await fs.readdir('temp');
            for (const file of tempFiles) {
                try {
                    await fs.remove(path.join('temp', file));
                    cleanupResults.temp.cleaned++;
                    console.log(`Cleaned temp file: ${file}`);
                } catch (error) {
                    cleanupResults.temp.errors++;
                    console.warn(`Failed to clean temp file ${file}:`, error.message);
                }
            }
        } catch (error) {
            console.warn('Failed to read temp directory:', error.message);
        }

        // Clean hls directory if it exists
        try {
            if (await fs.pathExists('hls')) {
                const hlsFiles = await fs.readdir('hls');
                for (const file of hlsFiles) {
                    try {
                        await fs.remove(path.join('hls', file));
                        cleanupResults.hls.cleaned++;
                        console.log(`Cleaned HLS file/directory: ${file}`);
                    } catch (error) {
                        cleanupResults.hls.errors++;
                        console.warn(`Failed to clean HLS file ${file}:`, error.message);
                    }
                }
            }
        } catch (error) {
            console.warn('Failed to read hls directory:', error.message);
        }

        const totalCleaned = cleanupResults.uploads.cleaned + cleanupResults.temp.cleaned + cleanupResults.hls.cleaned;
        const totalErrors = cleanupResults.uploads.errors + cleanupResults.temp.errors + cleanupResults.hls.errors;

        res.json({
            success: true,
            message: `Cleanup completed: ${totalCleaned} files cleaned, ${totalErrors} errors`,
            details: cleanupResults
        });

    } catch (error) {
        console.error('Cleanup error:', error);
        res.status(500).json({ error: error.message });
    }
});

// Automatic cleanup function
const performAutomaticCleanup = async () => {
    try {
        console.log('Performing automatic cleanup of temporary files...');
        
        // Clean uploads directory (files older than 1 hour)
        try {
            const uploadFiles = await fs.readdir('uploads');
            let cleanedCount = 0;
            
            for (const file of uploadFiles) {
                const filePath = path.join('uploads', file);
                const stats = await fs.stat(filePath);
                const fileAge = Date.now() - stats.mtime.getTime();
                
                // Remove files older than 1 hour (3600000 ms)
                if (fileAge > 3600000) {
                    await fs.remove(filePath);
                    cleanedCount++;
                    console.log(`Auto-cleaned old upload file: ${file}`);
                }
            }
            
            if (cleanedCount > 0) {
                console.log(`Auto-cleanup: Removed ${cleanedCount} old upload files`);
            }
        } catch (error) {
            console.warn('Auto-cleanup uploads failed:', error.message);
        }

        // Clean temp directory (files older than 30 minutes)
        try {
            const tempFiles = await fs.readdir('temp');
            let cleanedCount = 0;
            
            for (const file of tempFiles) {
                const filePath = path.join('temp', file);
                const stats = await fs.stat(filePath);
                const fileAge = Date.now() - stats.mtime.getTime();
                
                // Remove files older than 30 minutes (1800000 ms)
                if (fileAge > 1800000) {
                    await fs.remove(filePath);
                    cleanedCount++;
                    console.log(`Auto-cleaned old temp file: ${file}`);
                }
            }
            
            if (cleanedCount > 0) {
                console.log(`Auto-cleanup: Removed ${cleanedCount} old temp files`);
            }
        } catch (error) {
            console.warn('Auto-cleanup temp failed:', error.message);
        }
        
    } catch (error) {
        console.warn('Automatic cleanup failed:', error.message);
    }
};

// Start server
const startServer = async () => {
    try {
        await ensureDirectories();
        await databaseService.initialize();
        
        // Start automatic cleanup every 30 minutes
        setInterval(performAutomaticCleanup, 30 * 60 * 1000); // 30 minutes
        
        // Perform initial cleanup
        setTimeout(performAutomaticCleanup, 5000); // After 5 seconds
        
        app.listen(PORT, () => {
            console.log(`Server running on http://localhost:${PORT}`);
            console.log('Make sure to configure your .env file with Telegram bot credentials');
            console.log('Automatic cleanup enabled: uploads (1h), temp (30min)');
        });
    } catch (error) {
        console.error('Failed to start server:', error);
        process.exit(1);
    }
};

startServer();