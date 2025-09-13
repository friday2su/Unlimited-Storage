const ffmpeg = require('fluent-ffmpeg');
const path = require('path');
const fs = require('fs-extra');

class AudioExtractor {
    constructor() {
        // Set FFmpeg paths if specified in environment
        if (process.env.FFMPEG_PATH) {
            ffmpeg.setFfmpegPath(process.env.FFMPEG_PATH);
        }
        if (process.env.FFPROBE_PATH) {
            ffmpeg.setFfprobePath(process.env.FFPROBE_PATH);
        }
    }

    /**
     * Extract all audio tracks from a video file as separate audio files
     * @param {string} videoPath - Path to the source video file
     * @param {string} videoId - Unique identifier for the video
     * @param {Array} audioTracks - Array of audio track metadata
     * @param {Function} progressCallback - Optional progress callback
     * @returns {Promise<Array>} Array of extracted audio file information
     */
    async extractAudioTracks(videoPath, videoId, audioTracks, progressCallback = null) {
        if (!audioTracks || audioTracks.length <= 1) {
            console.log('Video has single or no audio tracks, skipping separate extraction');
            return [];
        }

        const audioDir = path.join(__dirname, '..', 'audio', videoId);
        await fs.ensureDir(audioDir);

        const extractedAudioFiles = [];
        const totalTracks = audioTracks.length;

        console.log(`Extracting ${totalTracks} audio tracks for video ${videoId}`);

        if (progressCallback) {
            await progressCallback(0, `Starting audio extraction for ${totalTracks} tracks`);
        }

        for (let i = 0; i < audioTracks.length; i++) {
            const track = audioTracks[i];
            const trackIndex = track.index || i;
            
            try {
                if (progressCallback) {
                    const progress = (i / totalTracks) * 100;
                    await progressCallback(Math.round(progress), `Extracting audio track ${i + 1}: ${track.title || track.language || `Track ${i + 1}`}`);
                }

                const audioFileName = this.generateAudioFileName(videoId, trackIndex, track);
                const audioFilePath = path.join(audioDir, audioFileName);

                // Extract audio track with high quality
                await this.extractSingleAudioTrack(videoPath, audioFilePath, trackIndex, track);

                // Verify the extracted file
                const stats = await fs.stat(audioFilePath);
                if (stats.size === 0) {
                    throw new Error(`Extracted audio file is empty for track ${trackIndex}`);
                }

                const audioFileInfo = {
                    trackIndex: trackIndex,
                    originalTrackInfo: track,
                    fileName: audioFileName,
                    filePath: audioFilePath,
                    fileSize: stats.size,
                    language: track.language || 'unknown',
                    title: track.title || `Audio Track ${i + 1}`,
                    codec: 'aac', // We convert to AAC for compatibility
                    channels: track.channels,
                    sampleRate: track.sampleRate,
                    extractionTime: new Date().toISOString()
                };

                extractedAudioFiles.push(audioFileInfo);
                console.log(`Successfully extracted audio track ${i + 1}: ${audioFileName}`);

            } catch (error) {
                console.error(`Failed to extract audio track ${i + 1}:`, error);
                // Continue with other tracks even if one fails
            }
        }

        if (progressCallback) {
            await progressCallback(100, `Audio extraction complete: ${extractedAudioFiles.length}/${totalTracks} tracks extracted`);
        }

        console.log(`Audio extraction completed: ${extractedAudioFiles.length} tracks extracted`);
        return extractedAudioFiles;
    }

    /**
     * Extract a single audio track from the video
     * @param {string} videoPath - Source video path
     * @param {string} outputPath - Output audio file path
     * @param {number} trackIndex - Audio track index
     * @param {Object} trackInfo - Audio track metadata
     * @returns {Promise<void>}
     */
    async extractSingleAudioTrack(videoPath, outputPath, trackIndex, trackInfo) {
        return new Promise((resolve, reject) => {
            const command = ffmpeg(videoPath)
                .outputOptions([
                    `-map`, `0:a:${trackIndex}`, // Map specific audio track
                    `-c:a`, 'aac', // Convert to AAC for compatibility
                    `-b:a`, '192k', // High quality audio bitrate
                    `-ac`, '2', // Stereo output
                    `-ar`, '48000', // Standard sample rate
                    '-avoid_negative_ts', 'make_zero', // Avoid timing issues
                    '-copyts', // Copy timestamps for synchronization
                    '-start_at_zero' // Start at zero for proper sync
                ])
                .output(outputPath)
                .on('start', (commandLine) => {
                    console.log(`Extracting audio track ${trackIndex}: ${commandLine}`);
                })
                .on('progress', (progress) => {
                    if (progress.percent) {
                        console.log(`Audio track ${trackIndex}: ${Math.round(progress.percent)}% extracted`);
                    }
                })
                .on('end', () => {
                    console.log(`Audio track ${trackIndex} extraction completed`);
                    resolve();
                })
                .on('error', (error) => {
                    console.error(`Audio track ${trackIndex} extraction failed:`, error);
                    reject(error);
                });

            command.run();
        });
    }

    /**
     * Generate a standardized filename for extracted audio
     * @param {string} videoId - Video identifier
     * @param {number} trackIndex - Audio track index
     * @param {Object} trackInfo - Audio track metadata
     * @returns {string} Generated filename
     */
    generateAudioFileName(videoId, trackIndex, trackInfo) {
        const language = trackInfo.language && trackInfo.language !== 'unknown' 
            ? trackInfo.language 
            : `track${trackIndex}`;
        
        const title = trackInfo.title 
            ? trackInfo.title.replace(/[^a-zA-Z0-9]/g, '_').toLowerCase()
            : `audio_${trackIndex}`;

        return `${videoId}_${language}_${title}_track${trackIndex}.aac`;
    }

    /**
     * Create audio-only HLS streams for seamless switching
     * @param {Array} extractedAudioFiles - Array of extracted audio file info
     * @param {string} videoId - Video identifier
     * @param {Function} progressCallback - Optional progress callback
     * @returns {Promise<Array>} Array of HLS audio stream information
     */
    async createAudioHLSStreams(extractedAudioFiles, videoId, progressCallback = null) {
        if (!extractedAudioFiles || extractedAudioFiles.length === 0) {
            return [];
        }

        const hlsAudioDir = path.join(__dirname, '..', 'hls', videoId, 'audio');
        await fs.ensureDir(hlsAudioDir);

        const audioHLSStreams = [];
        const totalFiles = extractedAudioFiles.length;

        if (progressCallback) {
            await progressCallback(0, 'Creating audio HLS streams');
        }

        for (let i = 0; i < extractedAudioFiles.length; i++) {
            const audioFile = extractedAudioFiles[i];
            
            try {
                if (progressCallback) {
                    const progress = (i / totalFiles) * 100;
                    await progressCallback(Math.round(progress), `Creating HLS for audio track: ${audioFile.title}`);
                }

                const hlsStreamInfo = await this.createSingleAudioHLS(audioFile, hlsAudioDir);
                audioHLSStreams.push(hlsStreamInfo);

            } catch (error) {
                console.error(`Failed to create HLS for audio track ${audioFile.trackIndex}:`, error);
            }
        }

        if (progressCallback) {
            await progressCallback(100, `Audio HLS streams created: ${audioHLSStreams.length} streams`);
        }

        return audioHLSStreams;
    }

    /**
     * Create HLS stream for a single audio file
     * @param {Object} audioFile - Audio file information
     * @param {string} hlsAudioDir - HLS audio directory
     * @returns {Promise<Object>} HLS stream information
     */
    async createSingleAudioHLS(audioFile, hlsAudioDir) {
        const trackDir = path.join(hlsAudioDir, `track_${audioFile.trackIndex}`);
        await fs.ensureDir(trackDir);

        const playlistPath = path.join(trackDir, 'playlist.m3u8');
        const segmentPattern = path.join(trackDir, 'segment_%03d.ts').replace(/\\/g, '/');

        return new Promise((resolve, reject) => {
            ffmpeg(audioFile.filePath)
                .outputOptions([
                    '-c:a', 'aac',
                    '-b:a', '128k',
                    '-ac', '2',
                    '-ar', '48000',
                    '-f', 'hls',
                    '-hls_time', '6',
                    '-hls_list_size', '0',
                    '-hls_segment_filename', segmentPattern,
                    '-avoid_negative_ts', 'make_zero',
                    '-copyts',
                    '-start_at_zero'
                ])
                .output(playlistPath)
                .on('start', (commandLine) => {
                    console.log(`Creating audio HLS for track ${audioFile.trackIndex}: ${commandLine}`);
                })
                .on('end', () => {
                    console.log(`Audio HLS created for track ${audioFile.trackIndex}`);
                    resolve({
                        ...audioFile,
                        hlsPlaylistPath: playlistPath,
                        hlsPlaylistUrl: `/api/hls/${path.basename(path.dirname(hlsAudioDir))}/audio/track_${audioFile.trackIndex}/playlist.m3u8`,
                        segmentDir: trackDir
                    });
                })
                .on('error', (error) => {
                    console.error(`Audio HLS creation failed for track ${audioFile.trackIndex}:`, error);
                    reject(error);
                })
                .run();
        });
    }

    /**
     * Clean up extracted audio files (call after successful upload to cloud)
     * @param {Array} extractedAudioFiles - Array of audio file information
     * @returns {Promise<void>}
     */
    async cleanupAudioFiles(extractedAudioFiles) {
        if (!extractedAudioFiles || extractedAudioFiles.length === 0) {
            return;
        }

        for (const audioFile of extractedAudioFiles) {
            try {
                if (await fs.pathExists(audioFile.filePath)) {
                    await fs.remove(audioFile.filePath);
                    console.log(`Cleaned up audio file: ${audioFile.fileName}`);
                }
            } catch (error) {
                console.warn(`Failed to cleanup audio file ${audioFile.fileName}:`, error);
            }
        }

        // Try to remove the audio directory if it's empty
        try {
            const audioDir = path.dirname(extractedAudioFiles[0].filePath);
            const remainingFiles = await fs.readdir(audioDir);
            if (remainingFiles.length === 0) {
                await fs.remove(audioDir);
                console.log(`Cleaned up empty audio directory: ${audioDir}`);
            }
        } catch (error) {
            console.warn('Failed to cleanup audio directory:', error);
        }
    }

    /**
     * Get audio track synchronization information
     * @param {string} videoPath - Source video path
     * @param {Array} audioTracks - Audio track metadata
     * @returns {Promise<Object>} Synchronization information
     */
    async getAudioSyncInfo(videoPath, audioTracks) {
        return new Promise((resolve, reject) => {
            ffmpeg.ffprobe(videoPath, ['-v', 'quiet', '-show_streams', '-select_streams', 'a'], (err, metadata) => {
                if (err) {
                    reject(err);
                    return;
                }

                const syncInfo = {
                    videoPath: videoPath,
                    audioTracks: audioTracks.map((track, index) => {
                        const streamInfo = metadata.streams[index];
                        return {
                            ...track,
                            startTime: streamInfo?.start_time || '0',
                            timeBase: streamInfo?.time_base || '1/48000',
                            duration: streamInfo?.duration || metadata.format?.duration,
                            syncOffset: 0 // Can be adjusted if needed
                        };
                    }),
                    extractionTimestamp: new Date().toISOString()
                };

                resolve(syncInfo);
            });
        });
    }
}

module.exports = AudioExtractor;