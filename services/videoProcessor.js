const ffmpeg = require('fluent-ffmpeg');
const path = require('path');
const fs = require('fs-extra');
const AudioExtractor = require('./audioExtractor');

class VideoProcessor {
    constructor() {
        // Set FFmpeg paths if specified in environment
        if (process.env.FFMPEG_PATH) {
            ffmpeg.setFfmpegPath(process.env.FFMPEG_PATH);
        }
        if (process.env.FFPROBE_PATH) {
            ffmpeg.setFfprobePath(process.env.FFPROBE_PATH);
        }
        
        // Initialize audio extractor
        this.audioExtractor = new AudioExtractor();
    }

    async getBasicMetadata(videoPath) {
        return new Promise((resolve, reject) => {
            // Use faster metadata extraction with limited probing
            ffmpeg.ffprobe(videoPath, ['-v', 'quiet', '-show_format', '-show_streams'], (err, metadata) => {
                if (err) {
                    // Fallback to file stats if ffprobe fails
                    const fs = require('fs-extra');
                    fs.stat(videoPath).then(stats => {
                        resolve({
                            duration: 0,
                            size: stats.size,
                            bitrate: null,
                            format: 'unknown',
                            video: null,
                            audio: []
                        });
                    }).catch(reject);
                    return;
                }

                const videoStream = metadata.streams.find(stream => stream.codec_type === 'video');
                const audioStreams = metadata.streams.filter(stream => stream.codec_type === 'audio');
                
                const result = {
                    duration: metadata.format.duration || 0,
                    size: metadata.format.size || 0,
                    bitrate: metadata.format.bit_rate || null,
                    format: metadata.format.format_name || 'unknown',
                    video: videoStream ? {
                        codec: videoStream.codec_name,
                        width: videoStream.width,
                        height: videoStream.height,
                        fps: this.calculateFPS(videoStream.r_frame_rate),
                        bitrate: videoStream.bit_rate
                    } : null,
                    audio: audioStreams.slice(0, 1).map(stream => ({ // Only first audio track for speed
                        codec: stream.codec_name,
                        channels: stream.channels,
                        sampleRate: stream.sample_rate,
                        bitrate: stream.bit_rate,
                        language: stream.tags?.language || 'unknown',
                        title: stream.tags?.title || `Audio ${stream.index}`
                    }))
                };

                resolve(result);
            });
        });
    }

    async getVideoMetadata(videoPath) {
        return new Promise((resolve, reject) => {
            ffmpeg.ffprobe(videoPath, (err, metadata) => {
                if (err) {
                    reject(err);
                    return;
                }

                const videoStream = metadata.streams.find(stream => stream.codec_type === 'video');
                const audioStreams = metadata.streams.filter(stream => stream.codec_type === 'audio');
                
                const result = {
                    duration: metadata.format.duration,
                    size: metadata.format.size,
                    bitrate: metadata.format.bit_rate,
                    format: metadata.format.format_name,
                    video: videoStream ? {
                        codec: videoStream.codec_name,
                        width: videoStream.width,
                        height: videoStream.height,
                        fps: this.calculateFPS(videoStream.r_frame_rate),
                        bitrate: videoStream.bit_rate
                    } : null,
                    audio: audioStreams.map(stream => ({
                        codec: stream.codec_name,
                        channels: stream.channels,
                        sampleRate: stream.sample_rate,
                        bitrate: stream.bit_rate,
                        language: stream.tags?.language || 'unknown',
                        title: stream.tags?.title || `Audio ${stream.index}`
                    }))
                };

                resolve(result);
            });
        });
    }

    async convertToHLS(videoPath, videoId, metadata) {
        const outputDir = path.join(__dirname, '..', 'hls', videoId);
        await fs.ensureDir(outputDir);

        // Generate multiple quality levels
        const qualities = this.getQualityLevels(metadata);
        const masterPlaylistPath = path.join(outputDir, 'playlist.m3u8');
        
        // Generate each quality level
        const variantPlaylists = [];
        
        for (const quality of qualities) {
            try {
                const variantPath = await this.generateHLSVariant(videoPath, outputDir, quality, metadata);
                variantPlaylists.push({
                    ...quality,
                    playlist: path.basename(variantPath)
                });
            } catch (error) {
                console.error(`Failed to generate ${quality.name} variant:`, error);
            }
        }
        
        // Create master playlist
        if (variantPlaylists.length > 0) {
            await this.createMasterHLSPlaylist(outputDir, variantPlaylists);
            return masterPlaylistPath;
        } else {
            throw new Error('Failed to generate any HLS variants');
        }
    }
    
    /**
     * Process multi-audio video with separate audio track extraction
     * @param {string} videoPath - Path to the video file
     * @param {string} videoId - Unique video identifier
     * @param {Object} metadata - Video metadata
     * @param {Function} progressCallback - Progress callback function
     * @returns {Promise<Object>} Processing results with HLS and audio info
     */
    async processMultiAudioVideo(videoPath, videoId, metadata, progressCallback) {
        const hasMultipleAudio = metadata.audio && metadata.audio.length > 1;
        const results = {
            hlsPath: null,
            extractedAudioFiles: [],
            audioHLSStreams: [],
            videoOnlyHLS: null,
            hasMultiAudio: hasMultipleAudio
        };

        try {
            // Step 1: Extract individual audio tracks if multiple exist
            if (hasMultipleAudio) {
                if (progressCallback) {
                    await progressCallback(5, 'Extracting audio tracks for multi-audio support', 'multi-audio');
                }

                results.extractedAudioFiles = await this.audioExtractor.extractAudioTracks(
                    videoPath, 
                    videoId, 
                    metadata.audio,
                    async (progress, stage) => {
                        if (progressCallback) {
                            const totalProgress = 5 + (progress * 0.15); // 5-20% for audio extraction
                            await progressCallback(Math.round(totalProgress), `Audio extraction: ${stage}`, 'multi-audio');
                        }
                    }
                );

                console.log(`Extracted ${results.extractedAudioFiles.length} audio tracks`);
            }

            // Step 2: Create video-only HLS (no audio) for multi-audio videos
            if (hasMultipleAudio) {
                if (progressCallback) {
                    await progressCallback(20, 'Creating video-only HLS stream', 'video-only');
                }

                results.videoOnlyHLS = await this.createVideoOnlyHLS(
                    videoPath, 
                    videoId, 
                    metadata,
                    async (progress, stage, quality) => {
                        if (progressCallback) {
                            const totalProgress = 20 + (progress * 0.4); // 20-60% for video-only HLS
                            await progressCallback(Math.round(totalProgress), stage, quality);
                        }
                    }
                );
            }

            // Step 3: Create regular HLS with audio (for single audio or fallback)
            const hlsStartProgress = hasMultipleAudio ? 60 : 10;
            const hlsProgressRange = hasMultipleAudio ? 25 : 80;

            if (progressCallback) {
                await progressCallback(hlsStartProgress, 'Creating standard HLS stream', null);
            }

            results.hlsPath = await this.convertToHLSWithProgress(
                videoPath, 
                videoId, 
                metadata,
                async (progress, stage, quality) => {
                    if (progressCallback) {
                        const totalProgress = hlsStartProgress + (progress * hlsProgressRange / 100);
                        await progressCallback(Math.round(totalProgress), stage, quality);
                    }
                }
            );

            // Step 4: Create audio-only HLS streams for each extracted audio track
            if (hasMultipleAudio && results.extractedAudioFiles.length > 0) {
                if (progressCallback) {
                    await progressCallback(85, 'Creating audio-only HLS streams', 'audio-hls');
                }

                results.audioHLSStreams = await this.audioExtractor.createAudioHLSStreams(
                    results.extractedAudioFiles,
                    videoId,
                    async (progress, stage) => {
                        if (progressCallback) {
                            const totalProgress = 85 + (progress * 0.1); // 85-95% for audio HLS
                            await progressCallback(Math.round(totalProgress), `Audio HLS: ${stage}`, 'audio-hls');
                        }
                    }
                );

                console.log(`Created ${results.audioHLSStreams.length} audio HLS streams`);
            }

            if (progressCallback) {
                await progressCallback(100, 'Multi-audio processing complete', null);
            }

            return results;

        } catch (error) {
            console.error('Multi-audio processing failed:', error);
            throw error;
        }
    }

    /**
     * Create video-only HLS stream (without audio) for multi-audio videos
     * @param {string} videoPath - Source video path
     * @param {string} videoId - Video identifier
     * @param {Object} metadata - Video metadata
     * @param {Function} progressCallback - Progress callback
     * @returns {Promise<string>} Video-only HLS playlist path
     */
    async createVideoOnlyHLS(videoPath, videoId, metadata, progressCallback) {
        const outputDir = path.join(__dirname, '..', 'hls', videoId, 'video-only');
        await fs.ensureDir(outputDir);

        // Generate multiple quality levels for video-only
        const qualities = this.getQualityLevels(metadata);
        const masterPlaylistPath = path.join(outputDir, 'playlist.m3u8');
        
        const variantPlaylists = [];
        const totalQualities = qualities.length;

        if (progressCallback) {
            await progressCallback(0, 'Starting video-only HLS generation', null);
        }

        for (let i = 0; i < qualities.length; i++) {
            const quality = qualities[i];
            try {
                if (progressCallback) {
                    const baseProgress = (i / totalQualities) * 90;
                    await progressCallback(Math.round(baseProgress), `Creating video-only ${quality.name}`, quality.name);
                }

                const variantPath = await this.generateVideoOnlyHLSVariant(
                    videoPath, 
                    outputDir, 
                    quality, 
                    metadata,
                    progressCallback ? async (variantProgress) => {
                        const totalProgress = ((i / totalQualities) + (variantProgress / 100) / totalQualities) * 90;
                        await progressCallback(Math.round(totalProgress), `Processing video-only ${quality.name}`, quality.name);
                    } : null
                );
                
                variantPlaylists.push({
                    ...quality,
                    playlist: path.basename(variantPath)
                });
            } catch (error) {
                console.error(`Failed to generate video-only ${quality.name} variant:`, error);
            }
        }

        // Create master playlist for video-only
        if (progressCallback) {
            await progressCallback(95, 'Creating video-only master playlist', null);
        }

        if (variantPlaylists.length > 0) {
            await this.createVideoOnlyMasterPlaylist(outputDir, variantPlaylists);
            
            if (progressCallback) {
                await progressCallback(100, 'Video-only HLS generation complete', null);
            }
            
            return masterPlaylistPath;
        } else {
            throw new Error('Failed to generate any video-only HLS variants');
        }
    }

    /**
     * Generate a single video-only HLS variant
     * @param {string} videoPath - Source video path
     * @param {string} outputDir - Output directory
     * @param {Object} quality - Quality settings
     * @param {Object} metadata - Video metadata
     * @param {Function} progressCallback - Progress callback
     * @returns {Promise<string>} Variant playlist path
     */
    async generateVideoOnlyHLSVariant(videoPath, outputDir, quality, metadata, progressCallback) {
        const variantDir = path.join(outputDir, quality.name);
        await fs.ensureDir(variantDir);
        
        const playlistPath = path.join(variantDir, 'playlist.m3u8');
        const segmentPattern = path.join(variantDir, 'segment_%03d.ts').replace(/\\/g, '/');
        
        return new Promise((resolve, reject) => {
            const command = ffmpeg(videoPath)
                .outputOptions([
                    '-map', '0:v:0',  // Map only video, no audio
                    '-an',  // No audio
                    '-c:v', 'libx264',
                    '-preset', 'fast',
                    '-crf', '23',
                    '-s', `${quality.width}x${quality.height}`,
                    '-b:v', quality.videoBitrate,
                    '-maxrate', quality.videoBitrate,
                    '-bufsize', `${parseInt(quality.videoBitrate) * 2}k`,
                    '-g', '48',
                    '-keyint_min', '48',
                    '-sc_threshold', '0',
                    '-f', 'hls',
                    '-hls_time', '6',
                    '-hls_list_size', '0',
                    '-hls_segment_filename', segmentPattern
                ])
                .output(playlistPath)
                .on('start', (commandLine) => {
                    console.log(`Generating video-only ${quality.name} HLS variant...`);
                })
                .on('progress', (progress) => {
                    if (progress.percent && progressCallback) {
                        progressCallback(Math.round(progress.percent)).catch(err => console.warn('Progress callback error:', err));
                    }
                })
                .on('end', () => {
                    console.log(`Video-only ${quality.name} HLS variant completed`);
                    resolve(playlistPath);
                })
                .on('error', (err) => {
                    console.error(`Video-only ${quality.name} HLS error:`, err);
                    reject(err);
                })
                .run();
        });
    }

    /**
     * Create master playlist for video-only HLS
     * @param {string} outputDir - Output directory
     * @param {Array} variants - Video variants
     * @returns {Promise<string>} Master playlist path
     */
    async createVideoOnlyMasterPlaylist(outputDir, variants) {
        let content = '#EXTM3U\n';
        content += '#EXT-X-VERSION:4\n\n';
        
        // Add each variant (video-only)
        variants.forEach(variant => {
            const bandwidth = parseInt(variant.videoBitrate) * 1000;
            content += `#EXT-X-STREAM-INF:BANDWIDTH=${bandwidth},RESOLUTION=${variant.width}x${variant.height},NAME="${variant.name}",CODECS="avc1.42E01E"\n`;
            content += `${variant.name}/playlist.m3u8\n\n`;
        });
        
        const masterPath = path.join(outputDir, 'playlist.m3u8');
        await fs.writeFile(masterPath, content);
        console.log('Video-only master HLS playlist created');
        return masterPath;
    }

    async convertToHLSWithProgress(videoPath, videoId, metadata, progressCallback) {
        const outputDir = path.join(__dirname, '..', 'hls', videoId);
        await fs.ensureDir(outputDir);

        // Generate multiple quality levels
        const qualities = this.getQualityLevels(metadata);
        const masterPlaylistPath = path.join(outputDir, 'playlist.m3u8');
        
        // Generate each quality level with progress tracking
        const variantPlaylists = [];
        const totalQualities = qualities.length;
        
        if (progressCallback) {
            await progressCallback(0, 'Starting HLS generation');
        }
        
        for (let i = 0; i < qualities.length; i++) {
            const quality = qualities[i];
            try {
                if (progressCallback) {
                    const baseProgress = (i / totalQualities) * 90; // Reserve 10% for finalization
                    await progressCallback(Math.round(baseProgress), `Starting ${quality.name} quality`, quality.name);
                }
                
                const variantPath = await this.generateHLSVariantWithProgress(
                    videoPath, 
                    outputDir, 
                    quality, 
                    metadata,
                    progressCallback ? async (variantProgress) => {
                        const totalProgress = ((i / totalQualities) + (variantProgress / 100) / totalQualities) * 90;
                        await progressCallback(Math.round(totalProgress), `Processing ${quality.name}`, quality.name);
                    } : null
                );
                
                variantPlaylists.push({
                    ...quality,
                    playlist: path.basename(variantPath)
                });
                
                // Notify quality completion
                if (progressCallback) {
                    const completedProgress = ((i + 1) / totalQualities) * 90;
                    await progressCallback(Math.round(completedProgress), `Completed ${quality.name} quality`, quality.name);
                }
            } catch (error) {
                console.error(`Failed to generate ${quality.name} variant:`, error);
                if (progressCallback) {
                    await progressCallback(Math.round(((i + 1) / totalQualities) * 90), `Failed to generate ${quality.name}`, quality.name);
                }
            }
        }
        
        // Create master playlist
        if (progressCallback) {
            await progressCallback(95, 'Creating master playlist', null);
        }
        
        if (variantPlaylists.length > 0) {
            await this.createMasterHLSPlaylist(outputDir, variantPlaylists);
            
            if (progressCallback) {
                await progressCallback(100, 'HLS generation complete', null);
            }
            
            return masterPlaylistPath;
        } else {
            throw new Error('Failed to generate any HLS variants');
        }
    }
    
    getQualityLevels(metadata) {
        const qualities = [];
        const originalHeight = metadata.video?.height || 720;
        
        // Define available quality levels
        const levels = [
            { name: '1080p', width: 1920, height: 1080, videoBitrate: '5000k', audioBitrate: '192k' },
            { name: '720p', width: 1280, height: 720, videoBitrate: '2800k', audioBitrate: '128k' },
            { name: '480p', width: 854, height: 480, videoBitrate: '1400k', audioBitrate: '128k' },
            { name: '360p', width: 640, height: 360, videoBitrate: '800k', audioBitrate: '96k' }
        ];
        
        // Only include qualities up to the original resolution
        return levels.filter(q => q.height <= originalHeight);
    }
    
    async generateHLSVariant(videoPath, outputDir, quality, metadata) {
        const variantDir = path.join(outputDir, quality.name);
        await fs.ensureDir(variantDir);
        
        const playlistPath = path.join(variantDir, 'playlist.m3u8');
        // Fix Windows path issues by using forward slashes for FFmpeg
        const segmentPattern = path.join(variantDir, 'segment_%03d.ts').replace(/\\/g, '/');
        
        return new Promise((resolve, reject) => {
            let command = ffmpeg(videoPath);
            
            // Handle multi-audio by mapping all available audio tracks to HLS
            const audioMappings = [];
            if (metadata.audio && metadata.audio.length > 0) {
                // Map all audio tracks for HLS
                for (let i = 0; i < Math.min(metadata.audio.length, 4); i++) { // Limit to 4 audio tracks
                    audioMappings.push('-map', `0:a:${i}?`);
                }
            }
            
            command = command
                .outputOptions([
                    '-map', '0:v:0',  // Map video
                    ...audioMappings   // Map audio tracks
                ])
                .videoCodec('libx264')
                .size(`${quality.width}x${quality.height}`)
                .videoBitrate(quality.videoBitrate);
            
            // Audio settings - handle multiple audio tracks
            if (metadata.audio && metadata.audio.length > 0) {
                command = command.audioCodec('aac');
                
                // Set audio parameters for each mapped track
                for (let i = 0; i < Math.min(metadata.audio.length, 4); i++) {
                    command = command.outputOptions([
                        `-c:a:${i}`, 'aac',
                        `-b:a:${i}`, quality.audioBitrate,
                        `-ac:a:${i}`, '2' // Stereo
                    ]);
                }
            } else {
                // No audio
                command = command.noAudio();
            }
            
            // Add all HLS and encoding options together
            command = command
                .format('hls')
                .outputOptions([
                    '-preset', 'fast',
                    '-crf', '23',
                    '-g', '48',
                    '-keyint_min', '48',
                    '-sc_threshold', '0',
                    '-hls_time', '6',
                    '-hls_list_size', '0',
                    '-hls_segment_filename', segmentPattern,
                    '-maxrate', quality.videoBitrate,
                    '-bufsize', `${parseInt(quality.videoBitrate) * 2}k`
                ]);
            
            command
                .output(playlistPath)
                .on('start', (commandLine) => {
                    console.log(`Generating ${quality.name} HLS variant...`);
                })
                .on('progress', (progress) => {
                    if (progress.percent) {
                        console.log(`${quality.name}: ${Math.round(progress.percent)}% done`);
                    }
                })
                .on('end', () => {
                    console.log(`${quality.name} HLS variant completed`);
                    resolve(playlistPath);
                })
                .on('error', (err) => {
                    console.error(`${quality.name} HLS error:`, err);
                    reject(err);
                })
                .run();
        });
    }
    
    async generateHLSVariantWithProgress(videoPath, outputDir, quality, metadata, progressCallback) {
        const variantDir = path.join(outputDir, quality.name);
        await fs.ensureDir(variantDir);
        
        const playlistPath = path.join(variantDir, 'playlist.m3u8');
        // Fix Windows path issues by using forward slashes for FFmpeg
        const segmentPattern = path.join(variantDir, 'segment_%03d.ts').replace(/\\/g, '/');
        
        return new Promise((resolve, reject) => {
            let command = ffmpeg(videoPath);
            
            // Handle multi-audio by mapping all available audio tracks to HLS
            const audioMappings = [];
            if (metadata.audio && metadata.audio.length > 0) {
                // Map all audio tracks for HLS
                for (let i = 0; i < Math.min(metadata.audio.length, 4); i++) { // Limit to 4 audio tracks
                    audioMappings.push('-map', `0:a:${i}?`);
                }
            }
            
            command = command
                .outputOptions([
                    '-map', '0:v:0',  // Map video
                    ...audioMappings   // Map audio tracks
                ])
                .videoCodec('libx264')
                .size(`${quality.width}x${quality.height}`)
                .videoBitrate(quality.videoBitrate);
            
            // Audio settings - handle multiple audio tracks
            if (metadata.audio && metadata.audio.length > 0) {
                command = command.audioCodec('aac');
                
                // Set audio parameters for each mapped track
                for (let i = 0; i < Math.min(metadata.audio.length, 4); i++) {
                    command = command.outputOptions([
                        `-c:a:${i}`, 'aac',
                        `-b:a:${i}`, quality.audioBitrate,
                        `-ac:a:${i}`, '2' // Stereo
                    ]);
                }
            } else {
                // No audio
                command = command.noAudio();
            }
            
            // Add all HLS and encoding options together
            command = command
                .format('hls')
                .outputOptions([
                    '-preset', 'fast',
                    '-crf', '23',
                    '-g', '48',
                    '-keyint_min', '48',
                    '-sc_threshold', '0',
                    '-hls_time', '6',
                    '-hls_list_size', '0',
                    '-hls_segment_filename', segmentPattern,
                    '-maxrate', quality.videoBitrate,
                    '-bufsize', `${parseInt(quality.videoBitrate) * 2}k`
                ]);
            
            command
                .output(playlistPath)
                .on('start', (commandLine) => {
                    console.log(`Generating ${quality.name} HLS variant...`);
                    if (progressCallback) {
                        progressCallback(0).catch(err => console.warn('Progress callback error:', err));
                    }
                })
                .on('progress', (progress) => {
                    if (progress.percent && progressCallback) {
                        progressCallback(Math.round(progress.percent)).catch(err => console.warn('Progress callback error:', err));
                        console.log(`${quality.name}: ${Math.round(progress.percent)}% done`);
                    }
                })
                .on('end', () => {
                    console.log(`${quality.name} HLS variant completed`);
                    if (progressCallback) {
                        progressCallback(100).catch(err => console.warn('Progress callback error:', err));
                    }
                    resolve(playlistPath);
                })
                .on('error', (err) => {
                    console.error(`${quality.name} HLS error:`, err);
                    reject(err);
                })
                .run();
        });
    }
    
    async createMasterHLSPlaylist(outputDir, variants) {
        let content = '#EXTM3U\n';
        content += '#EXT-X-VERSION:4\n\n';
        
        // Add each variant with improved audio support
        variants.forEach(variant => {
            const bandwidth = parseInt(variant.videoBitrate) * 1000 + parseInt(variant.audioBitrate) * 1000;
            content += `#EXT-X-STREAM-INF:BANDWIDTH=${bandwidth},RESOLUTION=${variant.width}x${variant.height},NAME="${variant.name}",CODECS="avc1.42E01E,mp4a.40.2"\n`;
            content += `${variant.name}/playlist.m3u8\n\n`;
        });
        
        const masterPath = path.join(outputDir, 'playlist.m3u8');
        await fs.writeFile(masterPath, content);
        console.log('Master HLS playlist created with audio track support');
        return masterPath;
    }

    addMultipleQualities(command, videoMetadata, outputDir) {
        if (!videoMetadata) return command;

        const width = videoMetadata.width;
        const height = videoMetadata.height;
        
        // Define quality levels based on original resolution
        const qualities = [];
        
        if (height >= 1080) {
            qualities.push({ name: '1080p', width: 1920, height: 1080, bitrate: '5000k' });
        }
        if (height >= 720) {
            qualities.push({ name: '720p', width: 1280, height: 720, bitrate: '3000k' });
        }
        if (height >= 480) {
            qualities.push({ name: '480p', width: 854, height: 480, bitrate: '1500k' });
        }
        qualities.push({ name: '360p', width: 640, height: 360, bitrate: '800k' });

        // Filter qualities that are not larger than original
        const validQualities = qualities.filter(q => q.height <= height);

        if (validQualities.length > 1) {
            // Create variant streams for different qualities
            validQualities.forEach((quality, index) => {
                command = command
                    .outputOptions([
                        `-map 0:v:0`,
                        `-map 0:a:0`,
                        `-s:v:${index} ${quality.width}x${quality.height}`,
                        `-b:v:${index} ${quality.bitrate}`,
                        `-maxrate:v:${index} ${quality.bitrate}`,
                        `-bufsize:v:${index} ${parseInt(quality.bitrate) * 2}k`
                    ]);
            });

            // Create master playlist
            this.createMasterPlaylist(outputDir, validQualities);
        }

        return command;
    }

    addMultipleAudioTracks(command, audioTracks, outputDir) {
        // Map all audio tracks
        audioTracks.forEach((track, index) => {
            command = command.outputOptions([
                `-map 0:a:${index}`,
                `-c:a:${index} aac`,
                `-b:a:${index} 128k`
            ]);
        });

        // Create audio-only playlists for each track
        this.createAudioPlaylists(outputDir, audioTracks);

        return command;
    }

    async createMasterPlaylist(outputDir, qualities) {
        let masterContent = '#EXTM3U\n#EXT-X-VERSION:3\n\n';

        qualities.forEach((quality) => {
            masterContent += `#EXT-X-STREAM-INF:BANDWIDTH=${parseInt(quality.bitrate) * 1000},RESOLUTION=${quality.width}x${quality.height}\n`;
            masterContent += `${quality.name}.m3u8\n\n`;
        });

        const masterPath = path.join(outputDir, 'master.m3u8');
        await fs.writeFile(masterPath, masterContent);
    }

    async createAudioPlaylists(outputDir, audioTracks) {
        let masterContent = '#EXTM3U\n#EXT-X-VERSION:3\n\n';

        audioTracks.forEach((track, index) => {
            const language = track.language || 'unknown';
            const title = track.title || `Audio ${index + 1}`;
            
            masterContent += `#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="audio",NAME="${title}",LANGUAGE="${language}",URI="audio_${index}.m3u8"\n`;
        });

        const audioMasterPath = path.join(outputDir, 'audio_master.m3u8');
        await fs.writeFile(audioMasterPath, masterContent);
    }

    async extractThumbnail(videoPath, outputPath, timeOffset = '00:00:10') {
        const outputDir = path.dirname(outputPath);
        const outputFilename = path.basename(outputPath);
        
        // Ensure output directory exists
        await fs.ensureDir(outputDir);
        
        return new Promise((resolve, reject) => {
            ffmpeg(videoPath)
                .screenshots({
                    timestamps: [timeOffset],
                    filename: outputFilename,
                    folder: outputDir,
                    size: '640x360'  // Larger size for better quality
                })
                .on('end', () => {
                    resolve(outputPath);
                })
                .on('error', (err) => {
                    // Try with a different timestamp if the first one fails
                    ffmpeg(videoPath)
                        .screenshots({
                            timestamps: ['00:00:01'],
                            filename: outputFilename,
                            folder: outputDir,
                            size: '640x360'
                        })
                        .on('end', () => {
                            resolve(outputPath);
                        })
                        .on('error', (finalErr) => {
                            reject(finalErr);
                        });
                });
        });
    }

    async getVideoInfo(videoPath) {
        try {
            const metadata = await this.getVideoMetadata(videoPath);
            return {
                duration: this.formatDuration(metadata.duration),
                size: this.formatFileSize(metadata.size),
                resolution: metadata.video ? `${metadata.video.width}x${metadata.video.height}` : 'Unknown',
                fps: metadata.video ? Math.round(metadata.video.fps) : 'Unknown',
                audioTracks: metadata.audio.length,
                format: metadata.format
            };
        } catch (error) {
            console.error('Error getting video info:', error);
            throw error;
        }
    }

    formatDuration(seconds) {
        const hours = Math.floor(seconds / 3600);
        const minutes = Math.floor((seconds % 3600) / 60);
        const secs = Math.floor(seconds % 60);
        
        if (hours > 0) {
            return `${hours}:${minutes.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
        } else {
            return `${minutes}:${secs.toString().padStart(2, '0')}`;
        }
    }

    formatFileSize(bytes) {
        const sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB'];
        if (bytes === 0) return '0 Bytes';
        const i = parseInt(Math.floor(Math.log(bytes) / Math.log(1024)));
        return Math.round(bytes / Math.pow(1024, i) * 100) / 100 + ' ' + sizes[i];
    }

    calculateFPS(frameRate) {
        if (!frameRate) return 0;
        
        // Handle fraction format like "30/1" or "25000/1001"
        if (typeof frameRate === 'string' && frameRate.includes('/')) {
            const [numerator, denominator] = frameRate.split('/').map(Number);
            return denominator ? numerator / denominator : 0;
        }
        
        // Handle direct number
        return parseFloat(frameRate) || 0;
    }

    async generateMultipleThumbnails(videoPath, videoId, percentages = [10, 30, 50, 70, 90]) {
        const outputDir = path.join(__dirname, '..', 'hls', videoId);
        await fs.ensureDir(outputDir);
        
        const thumbnails = [];
        
        // First, get video duration
        let videoDuration;
        try {
            const metadata = await this.getVideoMetadata(videoPath);
            videoDuration = metadata.duration;
        } catch (error) {
            console.error('Failed to get video duration for thumbnails:', error.message);
            return thumbnails;
        }
        
        if (!videoDuration || videoDuration <= 0) {
            console.warn('Invalid video duration, cannot generate thumbnails');
            return thumbnails;
        }
        
        for (let i = 0; i < percentages.length; i++) {
            const percentage = percentages[i];
            const timeInSeconds = Math.floor((videoDuration * percentage) / 100);
            const thumbnailPath = path.join(outputDir, `thumbnail_${i + 1}.jpg`);
            
            try {
                await new Promise((resolve, reject) => {
                    ffmpeg(videoPath)
                        .seekInput(timeInSeconds)
                        .frames(1)
                        .size('320x180')
                        .format('image2')
                        .outputOptions(['-q:v 2']) // High quality JPEG
                        .output(thumbnailPath)
                        .on('end', () => {
                            thumbnails.push({
                                index: i + 1,
                                timestamp: `${timeInSeconds}s`,
                                percentage: `${percentage}%`,
                                path: thumbnailPath,
                                filename: `thumbnail_${i + 1}.jpg`,
                                url: `/hls/${videoId}/thumbnail_${i + 1}.jpg`
                            });
                            resolve();
                        })
                        .on('error', reject)
                        .run();
                });
                console.log(`Generated thumbnail ${i + 1} at ${timeInSeconds}s (${percentage}%)`);
            } catch (error) {
                console.warn(`Failed to generate thumbnail ${i + 1} at ${timeInSeconds}s:`, error.message);
            }
        }
        
        return thumbnails;
    }

    async extractAdvancedMetadata(videoPath) {
        return new Promise((resolve, reject) => {
            ffmpeg.ffprobe(videoPath, (err, metadata) => {
                if (err) {
                    reject(err);
                    return;
                }

                const videoStream = metadata.streams.find(stream => stream.codec_type === 'video');
                const audioStreams = metadata.streams.filter(stream => stream.codec_type === 'audio');
                const subtitleStreams = metadata.streams.filter(stream => stream.codec_type === 'subtitle');
                
                const result = {
                    // Basic info
                    duration: metadata.format.duration,
                    size: metadata.format.size,
                    bitrate: metadata.format.bit_rate,
                    format: metadata.format.format_name,
                    filename: metadata.format.filename,
                    
                    // Video stream info
                    video: videoStream ? {
                        codec: videoStream.codec_name,
                        width: videoStream.width,
                        height: videoStream.height,
                        fps: this.calculateFPS(videoStream.r_frame_rate),
                        bitrate: videoStream.bit_rate,
                        pixelFormat: videoStream.pix_fmt,
                        profile: videoStream.profile,
                        level: videoStream.level,
                        aspectRatio: videoStream.display_aspect_ratio,
                        colorSpace: videoStream.color_space,
                        colorRange: videoStream.color_range
                    } : null,
                    
                    // Audio streams info
                    audio: audioStreams.map((stream, index) => ({
                        index: index,
                        codec: stream.codec_name,
                        channels: stream.channels,
                        channelLayout: stream.channel_layout,
                        sampleRate: stream.sample_rate,
                        bitrate: stream.bit_rate,
                        language: stream.tags?.language || 'unknown',
                        title: stream.tags?.title || `Audio ${index + 1}`,
                        profile: stream.profile
                    })),
                    
                    // Subtitle streams info
                    subtitles: subtitleStreams.map((stream, index) => ({
                        index: index,
                        codec: stream.codec_name,
                        language: stream.tags?.language || 'unknown',
                        title: stream.tags?.title || `Subtitle ${index + 1}`
                    })),
                    
                    // Additional metadata
                    metadata: {
                        creationTime: metadata.format.tags?.creation_time,
                        title: metadata.format.tags?.title,
                        artist: metadata.format.tags?.artist,
                        album: metadata.format.tags?.album,
                        date: metadata.format.tags?.date,
                        genre: metadata.format.tags?.genre,
                        comment: metadata.format.tags?.comment,
                        encoder: metadata.format.tags?.encoder
                    },
                    
                    // Quality assessment
                    quality: this.assessVideoQuality(videoStream, metadata.format),
                    
                    // Stream count
                    streamCount: {
                        total: metadata.streams.length,
                        video: metadata.streams.filter(s => s.codec_type === 'video').length,
                        audio: audioStreams.length,
                        subtitle: subtitleStreams.length
                    }
                };

                resolve(result);
            });
        });
    }

    assessVideoQuality(videoStream, formatInfo) {
        if (!videoStream) return null;
        
        const width = videoStream.width;
        const height = videoStream.height;
        const bitrate = videoStream.bit_rate || formatInfo.bit_rate;
        const fps = this.calculateFPS(videoStream.r_frame_rate);
        
        let resolution = 'unknown';
        let quality = 'unknown';
        
        if (height >= 2160) {
            resolution = '4K';
            quality = bitrate > 20000000 ? 'excellent' : bitrate > 15000000 ? 'good' : 'fair';
        } else if (height >= 1080) {
            resolution = '1080p';
            quality = bitrate > 8000000 ? 'excellent' : bitrate > 5000000 ? 'good' : 'fair';
        } else if (height >= 720) {
            resolution = '720p';
            quality = bitrate > 5000000 ? 'excellent' : bitrate > 3000000 ? 'good' : 'fair';
        } else if (height >= 480) {
            resolution = '480p';
            quality = bitrate > 2000000 ? 'good' : 'fair';
        } else {
            resolution = '360p';
            quality = 'fair';
        }
        
        return {
            resolution: resolution,
            quality: quality,
            fps: fps,
            bitrate: bitrate,
            aspectRatio: `${width}:${height}`
        };
    }

    async generateVideoPreview(videoPath, videoId, duration = 10) {
        const outputDir = path.join(__dirname, '..', 'hls', videoId);
        await fs.ensureDir(outputDir);
        
        const previewPath = path.join(outputDir, 'preview.mp4');
        
        // Get video duration to ensure we don't start too late
        let videoDuration;
        try {
            const metadata = await this.getVideoMetadata(videoPath);
            videoDuration = metadata.duration;
        } catch (error) {
            console.error('Failed to get video duration for preview:', error.message);
            videoDuration = 60; // Fallback to assuming 60 seconds
        }
        
        // Start at 10 seconds or 10% of video duration, whichever is smaller
        const startTime = Math.min(10, Math.floor(videoDuration * 0.1));
        const previewDuration = Math.min(duration, videoDuration - startTime - 1);
        
        return new Promise((resolve, reject) => {
            ffmpeg(videoPath)
                .seekInput(startTime) // Start time in seconds
                .duration(previewDuration) // Preview duration
                .size('640x360') // Lower resolution for preview
                .videoBitrate('500k')
                .audioBitrate('64k')
                .format('mp4')
                .output(previewPath)
                .on('start', (commandLine) => {
                    console.log(`Generating preview: ${commandLine}`);
                })
                .on('end', () => {
                    console.log(`Generated preview: ${previewDuration}s starting at ${startTime}s`);
                    resolve({
                        path: previewPath,
                        url: `/hls/${videoId}/preview.mp4`,
                        duration: previewDuration,
                        startTime: startTime
                    });
                })
                .on('error', (error) => {
                    console.error('Preview generation failed:', error.message);
                    reject(error);
                })
                .run();
        });
    }
    
    async mergeAudioTracks(videoPath, audioTracks, outputPath) {
        await fs.ensureDir(path.dirname(outputPath));
        
        return new Promise((resolve, reject) => {
            let command = ffmpeg(videoPath);
            
            // Add each audio track as input
            audioTracks.forEach(track => {
                command = command.input(track.path);
            });
            
            // Map video from first input
            command = command.outputOptions(['-map', '0:v']);
            
            // Map original audio (if exists) as first track
            command = command.outputOptions(['-map', '0:a?']);
            
            // Map additional audio tracks
            audioTracks.forEach((track, index) => {
                command = command.outputOptions([
                    '-map', `${index + 1}:a`,
                    `-metadata:s:a:${index + 1}`, `language=${track.language}`,
                    `-metadata:s:a:${index + 1}`, `title=${track.language.toUpperCase()} Audio`
                ]);
            });
            
            // Copy video codec, encode audio
            command = command
                .videoCodec('copy')
                .audioCodec('aac')
                .audioBitrate('128k')
                .outputOptions(['-movflags', '+faststart'])
                .output(outputPath)
                .on('start', (commandLine) => {
                    console.log('Merging audio tracks with command:', commandLine);
                })
                .on('progress', (progress) => {
                    console.log(`Merging progress: ${Math.round(progress.percent || 0)}%`);
                })
                .on('end', () => {
                    console.log('Audio tracks merged successfully');
                    resolve(outputPath);
                })
                .on('error', (err) => {
                    console.error('Error merging audio tracks:', err);
                    reject(err);
                })
                .run();
        });
    }
}

module.exports = VideoProcessor;
