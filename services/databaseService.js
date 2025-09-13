const fs = require('fs-extra');
const path = require('path');

class DatabaseService {
    constructor() {
        this.dataDir = path.join(__dirname, '..', 'data');
        this.videosFile = path.join(this.dataDir, 'videos.json');
        this.videos = new Map();
    }

    async initialize() {
        await fs.ensureDir(this.dataDir);
        
        if (await fs.pathExists(this.videosFile)) {
            try {
                const data = await fs.readJson(this.videosFile);
                this.videos = new Map(Object.entries(data));
                console.log(`Loaded ${this.videos.size} videos from database`);
            } catch (error) {
                console.error('Error loading database:', error);
                this.videos = new Map();
            }
        } else {
            await this.saveDatabase();
        }
    }

    async saveDatabase() {
        try {
            const data = Object.fromEntries(this.videos);
            await fs.writeJson(this.videosFile, data, { spaces: 2 });
        } catch (error) {
            console.error('Error saving database:', error);
            throw error;
        }
    }

    async saveVideo(videoData) {
        try {
            this.videos.set(videoData.id, videoData);
            await this.saveDatabase();
            console.log(`Video saved: ${videoData.originalName} (${videoData.id})`);
            return videoData;
        } catch (error) {
            console.error('Error saving video:', error);
            throw error;
        }
    }

    async getVideo(videoId) {
        return this.videos.get(videoId) || null;
    }

    async getAllVideos() {
        return Array.from(this.videos.values()).sort((a, b) => 
            new Date(b.uploadDate) - new Date(a.uploadDate)
        );
    }

    async updateVideo(videoId, updates) {
        const video = this.videos.get(videoId);
        if (!video) {
            throw new Error('Video not found');
        }

        const updatedVideo = { ...video, ...updates, updatedDate: new Date().toISOString() };
        this.videos.set(videoId, updatedVideo);
        await this.saveDatabase();
        
        return updatedVideo;
    }

    async updateVideoName(videoId, newName) {
        return await this.updateVideo(videoId, { originalName: newName });
    }

    async updateVideoMetadata(videoId, updates) {
        const video = this.videos.get(videoId);
        if (!video) {
            throw new Error('Video not found');
        }

        // Deep merge for processingStatus to prevent overwrites
        if (updates.processingStatus && video.processingStatus) {
            updates.processingStatus = { 
                ...video.processingStatus, 
                ...updates.processingStatus 
            };
        }

        // Merge the updates with existing video data
        const updatedVideo = { 
            ...video, 
            ...updates, 
            updatedDate: new Date().toISOString() 
        };
        
        this.videos.set(videoId, updatedVideo);
        await this.saveDatabase();
        
        return updatedVideo;
    }

    async deleteVideo(videoId) {
        const deleted = this.videos.delete(videoId);
        if (deleted) {
            await this.saveDatabase();
            console.log(`Video deleted: ${videoId}`);
        }
        return deleted;
    }

    async searchVideos(query) {
        const searchTerm = query.toLowerCase();
        return Array.from(this.videos.values()).filter(video => 
            video.originalName.toLowerCase().includes(searchTerm) ||
            video.id.toLowerCase().includes(searchTerm)
        );
    }

    async getVideosByDateRange(startDate, endDate) {
        const start = new Date(startDate);
        const end = new Date(endDate);
        
        return Array.from(this.videos.values()).filter(video => {
            const uploadDate = new Date(video.uploadDate);
            return uploadDate >= start && uploadDate <= end;
        });
    }

    async getVideoStats() {
        const videos = Array.from(this.videos.values());
        
        const totalVideos = videos.length;
        const totalSize = videos.reduce((sum, video) => sum + (video.size || 0), 0);
        const totalDuration = videos.reduce((sum, video) => 
            sum + (video.metadata?.duration || 0), 0
        );
        
        const formatCounts = {};
        videos.forEach(video => {
            const format = video.metadata?.format || 'unknown';
            formatCounts[format] = (formatCounts[format] || 0) + 1;
        });

        const resolutionCounts = {};
        videos.forEach(video => {
            if (video.metadata?.video) {
                const resolution = `${video.metadata.video.width}x${video.metadata.video.height}`;
                resolutionCounts[resolution] = (resolutionCounts[resolution] || 0) + 1;
            }
        });

        return {
            totalVideos,
            totalSize: this.formatFileSize(totalSize),
            totalDuration: this.formatDuration(totalDuration),
            formatCounts,
            resolutionCounts,
            averageSize: totalVideos > 0 ? this.formatFileSize(totalSize / totalVideos) : '0 Bytes',
            averageDuration: totalVideos > 0 ? this.formatDuration(totalDuration / totalVideos) : '0:00'
        };
    }

    formatFileSize(bytes) {
        const sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB'];
        if (bytes === 0) return '0 Bytes';
        const i = parseInt(Math.floor(Math.log(bytes) / Math.log(1024)));
        return Math.round(bytes / Math.pow(1024, i) * 100) / 100 + ' ' + sizes[i];
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

    async backup() {
        const backupFile = path.join(this.dataDir, `backup_${Date.now()}.json`);
        await fs.copy(this.videosFile, backupFile);
        console.log(`Database backed up to: ${backupFile}`);
        return backupFile;
    }

    async restore(backupFile) {
        if (await fs.pathExists(backupFile)) {
            await fs.copy(backupFile, this.videosFile);
            await this.initialize();
            console.log(`Database restored from: ${backupFile}`);
            return true;
        }
        return false;
    }

    async addVideoTags(videoId, tags) {
        const video = this.videos.get(videoId);
        if (!video) {
            throw new Error('Video not found');
        }

        video.tags = video.tags || [];
        const newTags = Array.isArray(tags) ? tags : [tags];
        
        newTags.forEach(tag => {
            if (tag && !video.tags.includes(tag.toLowerCase())) {
                video.tags.push(tag.toLowerCase());
            }
        });

        video.updatedDate = new Date().toISOString();
        await this.saveDatabase();
        return video.tags;
    }

    async setVideoCategory(videoId, category) {
        const video = this.videos.get(videoId);
        if (!video) {
            throw new Error('Video not found');
        }

        video.category = category;
        video.updatedDate = new Date().toISOString();
        await this.saveDatabase();
        return video;
    }

    async toggleFavorite(videoId) {
        const video = this.videos.get(videoId);
        if (!video) {
            throw new Error('Video not found');
        }

        video.favorite = !video.favorite;
        video.updatedDate = new Date().toISOString();
        await this.saveDatabase();
        return video.favorite;
    }

    async incrementViewCount(videoId) {
        const video = this.videos.get(videoId);
        if (!video) {
            throw new Error('Video not found');
        }

        video.viewCount = (video.viewCount || 0) + 1;
        video.lastViewed = new Date().toISOString();
        await this.saveDatabase();
        return video.viewCount;
    }

    async advancedSearch(criteria) {
        const {
            query,
            tags,
            category,
            minDuration,
            maxDuration,
            favorite,
            sortBy = 'uploadDate',
            sortOrder = 'desc',
            limit,
            offset = 0
        } = criteria;

        let results = Array.from(this.videos.values());

        if (query) {
            const searchTerm = query.toLowerCase();
            results = results.filter(video => 
                video.originalName.toLowerCase().includes(searchTerm) ||
                (video.tags && video.tags.some(tag => tag.includes(searchTerm)))
            );
        }

        if (tags && tags.length > 0) {
            const searchTags = tags.map(tag => tag.toLowerCase());
            results = results.filter(video => 
                video.tags && searchTags.every(tag => video.tags.includes(tag))
            );
        }

        if (category) {
            results = results.filter(video => video.category === category);
        }

        if (minDuration || maxDuration) {
            results = results.filter(video => {
                const duration = video.metadata?.duration || 0;
                return (!minDuration || duration >= minDuration) && 
                       (!maxDuration || duration <= maxDuration);
            });
        }

        if (favorite !== undefined) {
            results = results.filter(video => !!video.favorite === favorite);
        }

        results.sort((a, b) => {
            let aValue, bValue;
            
            switch (sortBy) {
                case 'name':
                    aValue = a.originalName.toLowerCase();
                    bValue = b.originalName.toLowerCase();
                    break;
                case 'size':
                    aValue = a.size || 0;
                    bValue = b.size || 0;
                    break;
                case 'duration':
                    aValue = a.metadata?.duration || 0;
                    bValue = b.metadata?.duration || 0;
                    break;
                case 'viewCount':
                    aValue = a.viewCount || 0;
                    bValue = b.viewCount || 0;
                    break;
                case 'uploadDate':
                default:
                    aValue = new Date(a.uploadDate);
                    bValue = new Date(b.uploadDate);
                    break;
            }

            if (aValue < bValue) return sortOrder === 'asc' ? -1 : 1;
            if (aValue > bValue) return sortOrder === 'asc' ? 1 : -1;
            return 0;
        });

        const total = results.length;
        if (limit) {
            results = results.slice(offset, offset + limit);
        }

        return { videos: results, total, offset, limit: limit || total };
    }

    async generateSharingLink(videoId, expiresInHours = 24) {
        const video = this.videos.get(videoId);
        if (!video) {
            throw new Error('Video not found');
        }

        const crypto = require('crypto');
        const shareId = crypto.randomBytes(16).toString('hex');
        const expiresAt = new Date(Date.now() + (expiresInHours * 60 * 60 * 1000));

        video.shareLinks = video.shareLinks || [];
        video.shareLinks.push({
            shareId: shareId,
            createdAt: new Date().toISOString(),
            expiresAt: expiresAt.toISOString(),
            active: true
        });

        await this.saveDatabase();
        return shareId;
    }

    async getVideoByShareId(shareId) {
        for (const [videoId, video] of this.videos) {
            if (video.shareLinks) {
                const shareLink = video.shareLinks.find(link => 
                    link.shareId === shareId && 
                    link.active && 
                    new Date(link.expiresAt) > new Date()
                );
                if (shareLink) {
                    return { videoId, video, shareLink };
                }
            }
        }
        return null;
    }
}

module.exports = DatabaseService;