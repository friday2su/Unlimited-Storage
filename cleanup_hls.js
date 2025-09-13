#!/usr/bin/env node

const fs = require('fs-extra');
const path = require('path');

/**
 * Manual HLS Cleanup Script
 * 
 * This script cleans up HLS directories that are taking up local storage space.
 * Based on the analysis, these directories should be cleaned up after successful
 * Telegram upload, but the cleanup may not be running due to failed HLS uploads
 * to Telegram (rate limiting) or missing FORCE_CLEANUP environment variable.
 * 
 * Usage:
 * node cleanup_hls.js [options]
 * 
 * Options:
 * --dry-run    Show what would be deleted without actually deleting
 * --force      Force cleanup even if database entries exist
 * --older-than <days>  Only clean files older than N days (default: 1)
 */

class HLSCleanup {
    constructor() {
        this.hlsDir = path.join(__dirname, 'hls');
        this.dataDir = path.join(__dirname, 'data');
        this.videosFile = path.join(this.dataDir, 'videos.json');
        this.dryRun = process.argv.includes('--dry-run');
        this.force = process.argv.includes('--force');
        
        // Parse --older-than parameter
        const olderThanIndex = process.argv.indexOf('--older-than');
        this.olderThanDays = olderThanIndex > -1 && process.argv[olderThanIndex + 1] !== undefined 
            ? parseInt(process.argv[olderThanIndex + 1]) 
            : 1;
    }

    async run() {
        console.log('🧹 HLS Directory Cleanup Script');
        console.log('================================');
        console.log(`Mode: ${this.dryRun ? 'DRY RUN (no files will be deleted)' : 'CLEANUP (files will be deleted)'}`);
        console.log(`Force cleanup: ${this.force ? 'YES' : 'NO'}`);
        console.log(`Clean files older than: ${this.olderThanDays} day(s)`);
        console.log('');

        try {
            // Check if HLS directory exists
            if (!await fs.pathExists(this.hlsDir)) {
                console.log('✅ No HLS directory found - nothing to clean');
                return;
            }

            // Load video database
            let videoDatabase = {};
            if (await fs.pathExists(this.videosFile)) {
                try {
                    videoDatabase = await fs.readJson(this.videosFile);
                    console.log(`📄 Loaded database with ${Object.keys(videoDatabase).length} video entries`);
                } catch (error) {
                    console.warn('⚠️  Failed to load video database:', error.message);
                    if (!this.force) {
                        console.log('❌ Cannot proceed without database unless --force is used');
                        return;
                    }
                }
            } else if (!this.force) {
                console.log('❌ No video database found. Use --force to cleanup anyway');
                return;
            }

            // Get all HLS directories
            const hlsDirectories = await this.getHLSDirectories();
            console.log(`📁 Found ${hlsDirectories.length} HLS directories`);
            
            if (hlsDirectories.length === 0) {
                console.log('✅ No HLS directories to clean');
                return;
            }

            console.log('');

            // Analyze each directory
            let totalSize = 0;
            const toCleanup = [];
            const cutoffDate = new Date(Date.now() - this.olderThanDays * 24 * 60 * 60 * 1000);

            for (const dir of hlsDirectories) {
                const dirPath = path.join(this.hlsDir, dir);
                const videoId = dir;
                
                try {
                    const stats = await fs.stat(dirPath);
                    const size = await this.getDirectorySize(dirPath);
                    const isOld = stats.mtime < cutoffDate;
                    
                    // Check database status
                    const videoEntry = videoDatabase[videoId];
                    const hasValidTelegramUpload = videoEntry?.telegramData?.uploaded === true;
                    const hlsUploadedToTelegram = videoEntry?.hlsCloudData?.uploaded === true;
                    
                    let shouldCleanup = false;
                    let reason = '';

                    if (!isOld) {
                        reason = `Too new (${this.formatDate(stats.mtime)})`;
                    } else if (!videoEntry) {
                        shouldCleanup = true;
                        reason = 'No database entry (orphaned)';
                    } else if (!hasValidTelegramUpload) {
                        reason = 'Video not uploaded to Telegram - keeping local backup';
                    } else if (hlsUploadedToTelegram) {
                        shouldCleanup = true;
                        reason = 'HLS successfully uploaded to Telegram';
                    } else if (this.force) {
                        shouldCleanup = true;
                        reason = 'Force cleanup enabled';
                    } else {
                        reason = 'HLS not uploaded to Telegram but video is backed up';
                        shouldCleanup = hasValidTelegramUpload; // Clean if video itself is backed up
                    }

                    console.log(`${shouldCleanup ? '🗑️ ' : '📁'} ${videoId}`);
                    console.log(`   📊 Size: ${this.formatSize(size)}`);
                    console.log(`   📅 Modified: ${this.formatDate(stats.mtime)}`);
                    console.log(`   💾 Telegram: ${hasValidTelegramUpload ? '✅ Uploaded' : '❌ Not uploaded'}`);
                    console.log(`   📺 HLS Cloud: ${hlsUploadedToTelegram ? '✅ Uploaded' : '❌ Not uploaded'}`);
                    console.log(`   🏷️  Action: ${reason}`);
                    console.log('');

                    if (shouldCleanup) {
                        toCleanup.push({ path: dirPath, videoId, size });
                        totalSize += size;
                    }

                } catch (error) {
                    console.log(`❌ ${videoId}: Error analyzing - ${error.message}`);
                    console.log('');
                }
            }

            // Summary
            console.log('📊 CLEANUP SUMMARY');
            console.log('==================');
            console.log(`Total directories: ${hlsDirectories.length}`);
            console.log(`To be cleaned: ${toCleanup.length}`);
            console.log(`Space to recover: ${this.formatSize(totalSize)}`);
            console.log('');

            if (toCleanup.length === 0) {
                console.log('✅ No directories need cleanup');
                return;
            }

            if (this.dryRun) {
                console.log('🔍 DRY RUN - No files were actually deleted');
                console.log('Run without --dry-run to perform actual cleanup');
                return;
            }

            // Perform cleanup
            console.log('🗑️  PERFORMING CLEANUP');
            console.log('======================');
            
            let cleanedCount = 0;
            let cleanedSize = 0;

            for (const item of toCleanup) {
                try {
                    console.log(`Deleting ${item.videoId}...`);
                    await fs.remove(item.path);
                    cleanedCount++;
                    cleanedSize += item.size;
                    console.log(`✅ Deleted ${item.videoId} (${this.formatSize(item.size)})`);
                } catch (error) {
                    console.log(`❌ Failed to delete ${item.videoId}: ${error.message}`);
                }
            }

            console.log('');
            console.log('✅ CLEANUP COMPLETE');
            console.log('===================');
            console.log(`Cleaned directories: ${cleanedCount}/${toCleanup.length}`);
            console.log(`Space recovered: ${this.formatSize(cleanedSize)}`);

        } catch (error) {
            console.error('❌ Cleanup script failed:', error);
            process.exit(1);
        }
    }

    async getHLSDirectories() {
        try {
            const items = await fs.readdir(this.hlsDir);
            const directories = [];
            
            for (const item of items) {
                const itemPath = path.join(this.hlsDir, item);
                const stats = await fs.stat(itemPath);
                if (stats.isDirectory()) {
                    directories.push(item);
                }
            }
            
            return directories;
        } catch (error) {
            console.error('Error reading HLS directory:', error);
            return [];
        }
    }

    async getDirectorySize(dirPath) {
        let totalSize = 0;
        
        try {
            const items = await fs.readdir(dirPath);
            
            for (const item of items) {
                const itemPath = path.join(dirPath, item);
                const stats = await fs.stat(itemPath);
                
                if (stats.isDirectory()) {
                    totalSize += await this.getDirectorySize(itemPath);
                } else {
                    totalSize += stats.size;
                }
            }
        } catch (error) {
            // Ignore errors for individual files
        }
        
        return totalSize;
    }

    formatSize(bytes) {
        const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
        if (bytes === 0) return '0 B';
        const i = parseInt(Math.floor(Math.log(bytes) / Math.log(1024)));
        return Math.round(bytes / Math.pow(1024, i) * 100) / 100 + ' ' + sizes[i];
    }

    formatDate(date) {
        return new Date(date).toLocaleString();
    }
}

// Show usage if help requested
if (process.argv.includes('--help') || process.argv.includes('-h')) {
    console.log(`
HLS Cleanup Script

Usage: node cleanup_hls.js [options]

Options:
  --dry-run           Show what would be deleted without actually deleting
  --force             Force cleanup even if database entries exist
  --older-than <days> Only clean files older than N days (default: 1)
  --help, -h          Show this help message

Examples:
  node cleanup_hls.js --dry-run                    # Preview cleanup
  node cleanup_hls.js                              # Clean files older than 1 day
  node cleanup_hls.js --older-than 7               # Clean files older than 7 days
  node cleanup_hls.js --force                      # Force cleanup regardless of database
`);
    process.exit(0);
}

// Run the cleanup
const cleanup = new HLSCleanup();
cleanup.run().catch(error => {
    console.error('Fatal error:', error);
    process.exit(1);
});