class StreamDriveApp {
    constructor() {
        this.videos = [];
        this.filteredVideos = [];
        this.currentPlayer = null;
        this.searchTerm = '';
        this.currentCategory = 'all';
        this.uploadQueue = [];
        this.isUploading = false;
        this.currentUploadIndex = 0;
        this.init();
    }

    init() {
        this.setupEventListeners();
        this.loadVideos();
        this.updateBackupStatus();
        
        // Initialize language
        if (window.lang) {
            const savedLang = localStorage.getItem('preferredLanguage') || 'en';
            document.getElementById('languageSelect').value = savedLang;
            window.lang.updateUI();
        }
    }
    
    changeLanguage(lang) {
        if (window.lang) {
            window.lang.setLanguage(lang);
        }
    }

    setupEventListeners() {
        // Upload modal events
        const uploadArea = document.getElementById('uploadArea');
        const fileInput = document.getElementById('fileInput');

        // File input change
        fileInput.addEventListener('change', (e) => this.handleFileSelect(e));

        // Upload area events
        uploadArea.addEventListener('click', () => fileInput.click());
        uploadArea.addEventListener('dragover', (e) => {
            e.preventDefault();
            uploadArea.classList.add('dragover');
        });
        uploadArea.addEventListener('dragleave', () => {
            uploadArea.classList.remove('dragover');
        });
        uploadArea.addEventListener('drop', (e) => {
            e.preventDefault();
            uploadArea.classList.remove('dragover');
            const files = Array.from(e.dataTransfer.files);
            if (files.length > 0) {
                this.addFilesToQueue(files);
            }
        });

        // Modal close events
        window.addEventListener('click', (e) => {
            if (e.target.id === 'uploadModal') {
                this.closeUploadModal();
            }
            if (e.target.id === 'playerModal') {
                this.closePlayer();
            }
            if (e.target.id === 'renameModal') {
                this.closeRenameModal();
            }
            if (e.target.id === 'deleteModal') {
                this.closeDeleteModal();
            }
        });

        // Keyboard shortcuts
        document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape') {
                this.closeUploadModal();
                this.closePlayer();
                this.closeRenameModal();
                this.closeDeleteModal();
            }
            // Enter key for rename modal
            if (e.key === 'Enter' && document.getElementById('renameModal').classList.contains('show')) {
                this.renameVideo();
            }
        });
    }

    // File Management
    async loadVideos() {
        const loadingSpinner = document.getElementById('loadingSpinner');
        
        try {
            if (loadingSpinner) {
                loadingSpinner.style.display = 'flex';
            }
            const response = await fetch('/api/videos');
            
            if (!response.ok) {
                throw new Error('Failed to load videos');
            }

            this.videos = await response.json();
            this.applyFilter();
        } catch (error) {
            console.error('Error loading videos:', error);
            this.showToast('Failed to load videos', 'error');
            this.showEmptyState('Error loading files');
        } finally {
            if (loadingSpinner) {
                loadingSpinner.style.display = 'none';
            }
        }
    }

    renderVideos() {
        const videosGrid = document.getElementById('videosGrid');
        const list = this.filteredVideos.length || this.searchTerm ? this.filteredVideos : this.videos;
        
        if (!list || list.length === 0) {
            this.showEmptyState(this.searchTerm ? 'No results found' : 'No videos uploaded yet');
            return;
        }

        videosGrid.innerHTML = '';

        list.forEach(video => {
            const videoCard = this.createVideoCard(video);
            videosGrid.appendChild(videoCard);
        });
    }

    applyFilter() {
        let filtered = [...this.videos];
        
        // Apply category filter
        if (this.currentCategory && this.currentCategory !== 'all') {
            filtered = filtered.filter(v => (v.category || 'other') === this.currentCategory);
        }
        
        // Apply search filter
        if (this.searchTerm) {
            const term = this.searchTerm.toLowerCase();
            filtered = filtered.filter(v => (v.originalName || '').toLowerCase().includes(term));
        }
        
        this.filteredVideos = filtered;
        this.renderVideos();
    }

    searchVideos(term) {
        this.searchTerm = term.trim();
        this.applyFilter();
    }
    
    filterByCategory(category) {
        this.currentCategory = category;
        
        // Update active button
        document.querySelectorAll('.category-btn').forEach(btn => {
            btn.classList.remove('active');
            if (btn.dataset.category === category) {
                btn.classList.add('active');
            }
        });
        
        this.applyFilter();
    }

    createVideoCard(video) {
        const card = document.createElement('div');
        card.className = 'video-card';
        card.dataset.videoId = video.id;
        
        const backupStatus = video.telegramData?.uploaded ? 'success' : 'error';
        const backupText = video.telegramData?.uploaded ? 'Backed up' : 'Backup failed';

        // Get cloud thumbnail URL
        const thumbnailUrl = video.cloudThumbnail 
            ? `/api/thumbnail/${video.id}` 
            : null;

        const thumbnailHtml = thumbnailUrl 
            ? `<img src="${thumbnailUrl}" alt="${video.originalName}" class="thumbnail-image"/>` 
            : `<div class="no-thumbnail">
                   <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1" opacity="0.3">
                       <rect x="2" y="2" width="20" height="20" rx="2.18" ry="2.18"/>
                       <line x1="7" y1="2" x2="7" y2="22"/>
                       <line x1="17" y1="2" x2="17" y2="22"/>
                       <line x1="2" y1="12" x2="22" y2="12"/>
                   </svg>
               </div>`;

        card.innerHTML = `
            <div class="video-preview" onclick="app.playVideo('${video.id}')">
                ${thumbnailHtml}
                <div class="play-overlay">
                    <svg width="24" height="24" viewBox="0 0 24 24" fill="white">
                        <path d="M8 5v14l11-7z"/>
                    </svg>
                </div>
            </div>
            <div class="video-info">
                <div class="video-title" title="${video.originalName}">
                    ${video.originalName}
                </div>
                <div class="video-meta">
                    <span class="video-size">${this.formatFileSize(video.size)}</span>
                    <span class="backup-status ${backupStatus}">${backupText}</span>
                </div>
                <div class="video-actions">
                    <button class="action-btn" onclick="app.playVideo('${video.id}')" title="Play">
                        <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
                            <path d="M8 5v14l11-7z"/>
                        </svg>
                    </button>
                    <button class="action-btn" onclick="app.downloadVideo('${video.id}')" title="Download">
                        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                            <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
                            <polyline points="7 10 12 15 17 10"/>
                            <line x1="12" y1="15" x2="12" y2="3"/>
                        </svg>
                    </button>
                    <button class="action-btn" onclick="app.copyVideoUrl('${video.id}')" title="Copy URL">
                        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                            <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/>
                            <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/>
                        </svg>
                    </button>
                    <button class="action-btn" onclick="app.showRenameModal('${video.id}')" title="Rename">
                        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                            <path d="M12 20h9"/>
                            <path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"/>
                        </svg>
                    </button>
                    <button class="action-btn" onclick="app.confirmDelete('${video.id}')" title="Delete">
                        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                            <polyline points="3 6 5 6 21 6"/>
                            <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>
                        </svg>
                    </button>
                </div>
            </div>
        `;

        return card;
    }

    showEmptyState(message) {
        const videosGrid = document.getElementById('videosGrid');
        videosGrid.innerHTML = `
            <div class="empty-state">
                <svg width="64" height="64" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1" opacity="0.3">
                    <rect x="2" y="2" width="20" height="20" rx="2.18" ry="2.18"/>
                    <line x1="7" y1="2" x2="7" y2="22"/>
                    <line x1="17" y1="2" x2="17" y2="22"/>
                    <line x1="2" y1="12" x2="22" y2="12"/>
                    <line x1="2" y1="7" x2="7" y2="7"/>
                    <line x1="2" y1="17" x2="7" y2="17"/>
                    <line x1="17" y1="17" x2="22" y2="17"/>
                    <line x1="17" y1="7" x2="22" y2="7"/>
                </svg>
                <h3>${message}</h3>
                <p>Upload your first video to get started</p>
            </div>
        `;
    }

    // Upload Functionality
    openUploadModal() {
        document.getElementById('uploadModal').classList.add('show');
    }

    closeUploadModal() {
        document.getElementById('uploadModal').classList.remove('show');
        
        const uploadProgress = document.getElementById('uploadProgress');
        const progressFill = document.getElementById('progressFill');
        const uploadQueue = document.getElementById('uploadQueue');
        
        if (uploadProgress) {
            uploadProgress.style.display = 'none';
        }
        if (progressFill) {
            progressFill.style.width = '0%';
        }
        if (uploadQueue) {
            uploadQueue.style.display = 'none';
        }
        
        // Clear file input
        const fileInput = document.getElementById('fileInput');
        if (fileInput) {
            fileInput.value = '';
        }
    }

    handleFileSelect(event) {
        const files = Array.from(event.target.files);
        if (files.length > 0) {
            this.addFilesToQueue(files);
        }
    }
    
    addFilesToQueue(files) {
        // Validate and add files to queue
        const validFiles = files.filter(file => this.validateFile(file));
        
        if (validFiles.length === 0) return;
        
        // Add files to queue
        validFiles.forEach(file => {
            this.uploadQueue.push({
                file: file,
                status: 'pending',
                progress: 0,
                id: Date.now() + Math.random()
            });
        });
        
        // Update queue display
        this.updateQueueDisplay();
        
        // Start processing queue if not already uploading
        if (!this.isUploading) {
            this.processUploadQueue();
        }
    }
    
    updateQueueDisplay() {
        const queueContainer = document.getElementById('uploadQueue');
        const queueList = document.getElementById('queueList');
        
        if (this.uploadQueue.length === 0) {
            queueContainer.style.display = 'none';
            return;
        }
        
        queueContainer.style.display = 'block';
        
        queueList.innerHTML = this.uploadQueue.map((item, index) => `
            <div class="queue-item ${item.status}">
                <span class="queue-item-name">${item.file.name}</span>
                <span class="queue-item-status">
                    ${item.status === 'uploading' ? `${Math.round(item.progress)}%` : 
                      item.status === 'completed' ? '✓' : 
                      item.status === 'failed' ? '✗' : 'Waiting...'}
                </span>
            </div>
        `).join('');
    }
    
    async processUploadQueue() {
        if (this.uploadQueue.length === 0 || this.isUploading) return;
        
        this.isUploading = true;
        
        while (this.uploadQueue.length > 0) {
            const currentItem = this.uploadQueue.find(item => item.status === 'pending');
            if (!currentItem) break;
            
            currentItem.status = 'uploading';
            this.updateQueueDisplay();
            
            const success = await this.uploadFile(currentItem.file, currentItem);
            
            currentItem.status = success ? 'completed' : 'failed';
            this.updateQueueDisplay();
            
            // Remove completed items after a delay
            if (success) {
                setTimeout(() => {
                    const index = this.uploadQueue.indexOf(currentItem);
                    if (index > -1) {
                        this.uploadQueue.splice(index, 1);
                        this.updateQueueDisplay();
                    }
                }, 3000);
            }
        }
        
        this.isUploading = false;
        
        // Check if all uploads are complete
        const allComplete = this.uploadQueue.every(item => 
            item.status === 'completed' || item.status === 'failed'
        );
        
        if (allComplete) {
            setTimeout(() => {
                this.closeUploadModal();
                this.uploadQueue = [];
                this.updateQueueDisplay();
            }, 2000);
        }
    }

    async uploadFile(file, queueItem = null) {
        if (!this.validateFile(file)) {
            return false;
        }

        const formData = new FormData();
        formData.append('video', file);

        const progressContainer = document.getElementById('uploadProgress');
        const progressFill = document.getElementById('progressFill');
        const progressText = document.getElementById('progressText');

        progressContainer.style.display = 'block';
        progressText.textContent = `Uploading ${file.name}...`;

        return new Promise((resolve) => {
            try {
                const xhr = new XMLHttpRequest();
                
                // Reset progress bar to 0
                progressFill.style.width = '0%';
                
                xhr.upload.addEventListener('progress', (e) => {
                    if (e.lengthComputable) {
                        const percentComplete = (e.loaded / e.total) * 100;
                        // Smooth progress update with slight delay for visual feedback
                        requestAnimationFrame(() => {
                            progressFill.style.width = percentComplete + '%';
                            progressText.textContent = `${window.lang ? window.lang.get('uploading') : 'Uploading'} ${file.name}... ${Math.round(percentComplete)}%`;
                        });
                        
                        // Update queue item progress
                        if (queueItem) {
                            queueItem.progress = percentComplete;
                            this.updateQueueDisplay();
                        }
                    }
                });

                xhr.addEventListener('load', () => {
                    if (xhr.status === 200) {
                        const response = JSON.parse(xhr.responseText);
                        const successMsg = window.lang ? `${file.name} ${window.lang.get('uploadSuccess')}` : `${file.name} uploaded successfully!`;
                        this.showToast(successMsg, 'success');
                        this.loadVideos();
                        progressText.textContent = window.lang ? window.lang.get('uploadComplete') : 'Upload complete!';
                        resolve(true);
                    } else {
                        const error = JSON.parse(xhr.responseText);
                        const errorMsg = window.lang ? `${window.lang.get('uploadFailed')} ${file.name}: ${error.error}` : `Failed to upload ${file.name}: ${error.error}`;
                        this.showToast(errorMsg, 'error');
                        resolve(false);
                    }
                    progressContainer.style.display = 'none';
                });

                xhr.addEventListener('error', () => {
                    this.showToast(`Failed to upload ${file.name}: Network error`, 'error');
                    progressContainer.style.display = 'none';
                    resolve(false);
                });

                xhr.open('POST', '/api/upload');
                xhr.send(formData);

            } catch (error) {
                console.error('Upload error:', error);
                this.showToast(`Failed to upload ${file.name}: ${error.message}`, 'error');
                progressContainer.style.display = 'none';
                resolve(false);
            }
        });
    }

    validateFile(file) {
        const maxSize = 2 * 1024 * 1024 * 1024; // 2GB

        if (!file.type.startsWith('video/')) {
            this.showToast(window.lang ? window.lang.get('selectValidFile') : 'Please select a valid video file', 'error');
            return false;
        }

        if (file.size > maxSize) {
            this.showToast(window.lang ? window.lang.get('fileSizeLimit') : 'File size must be less than 2GB', 'error');
            return false;
        }

        return true;
    }

    // Video Player - Fixed version
    async playVideo(videoId) {
        try {
            // First get video details
            const videoResponse = await fetch(`/api/video/${videoId}`);
            
            if (!videoResponse.ok) {
                const errorData = await videoResponse.json().catch(() => ({}));
                throw new Error(errorData.error || `Video not found (${videoResponse.status})`);
            }

            const video = await videoResponse.json();
            const modal = document.getElementById('playerModal');
            const playerTitle = document.getElementById('playerTitle');
            const videoPlayer = document.getElementById('videoPlayer');

            playerTitle.textContent = video.originalName;
            
            // Setup video player with direct stream URL
            const streamUrl = `/api/stream/${videoId}`;
            
            // Clean up any existing HLS player
            if (this.currentPlayer) {
                this.currentPlayer.destroy();
                this.currentPlayer = null;
            }

            // Clean up any existing error handler
            if (this.videoErrorHandler) {
                videoPlayer.removeEventListener('error', this.videoErrorHandler);
                this.videoErrorHandler = null;
            }

            // Reset video player
            videoPlayer.pause();
            videoPlayer.src = '';
            videoPlayer.load();

            // Create new error handler that only logs real errors
            this.videoErrorHandler = (e) => {
                // Only handle real errors, not empty source errors
                if (videoPlayer.src && videoPlayer.src !== '' && videoPlayer.src !== 'about:blank') {
                    console.error('Video playback error:', e);
                    this.showToast('Failed to play video: Streaming error', 'error');
                }
            };

            videoPlayer.addEventListener('error', this.videoErrorHandler);

            // Set the source and play
            videoPlayer.src = streamUrl;
            
            modal.classList.add('show');
            
            // Try to play the video
            videoPlayer.play().catch(error => {
                console.error('Video play failed:', error);
                this.showToast('Video failed to start playing', 'error');
            });
            
        } catch (error) {
            console.error('Error playing video:', error);
            this.showToast(`Failed to play video: ${error.message}`, 'error');
        }
    }

    closePlayer() {
        const modal = document.getElementById('playerModal');
        const videoPlayer = document.getElementById('videoPlayer');
        
        // Remove error handler before clearing the source
        if (this.videoErrorHandler) {
            videoPlayer.removeEventListener('error', this.videoErrorHandler);
            this.videoErrorHandler = null;
        }
        
        modal.classList.remove('show');
        videoPlayer.pause();
        
        // Clear source after removing event listener to avoid error events
        videoPlayer.removeAttribute('src');
        videoPlayer.load();
        
        if (this.currentPlayer) {
            this.currentPlayer.destroy();
            this.currentPlayer = null;
        }
    }

    // Video Actions
    downloadVideo(videoId) {
        const video = this.videos.find(v => v.id === videoId);
        if (video) {
            // Create download link
            const link = document.createElement('a');
            link.href = `/api/stream/${videoId}`;
            link.download = video.originalName;
            link.click();
            this.showToast('Download started', 'success');
        }
    }

    copyVideoUrl(videoId) {
        const streamUrl = `${window.location.origin}/api/stream/${videoId}`;
        
        navigator.clipboard.writeText(streamUrl).then(() => {
            this.showToast('Video URL copied to clipboard', 'success');
        }).catch(() => {
            this.showToast('Failed to copy URL', 'error');
        });
    }

    // Rename Video
    showRenameModal(videoId) {
        const video = this.videos.find(v => v.id === videoId);
        if (video) {
            this.currentRenameVideoId = videoId;
            const modal = document.getElementById('renameModal');
            const input = document.getElementById('newVideoName');
            
            // Set current name without extension
            const nameWithoutExt = video.originalName.replace(/\.[^/.]+$/, "");
            input.value = nameWithoutExt;
            
            modal.classList.add('show');
            input.focus();
            input.select();
        }
    }

    async renameVideo() {
        const newName = document.getElementById('newVideoName').value.trim();
        
        if (!newName) {
            this.showToast('Please enter a valid name', 'error');
            return;
        }

        if (!this.currentRenameVideoId) return;

        try {
            const video = this.videos.find(v => v.id === this.currentRenameVideoId);
            const originalExt = video.originalName.match(/\.[^/.]+$/)?.[0] || '';
            const fullNewName = newName + originalExt;

            const response = await fetch(`/api/video/${this.currentRenameVideoId}/rename`, {
                method: 'PUT',
                headers: {
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({ newName: fullNewName })
            });

            if (response.ok) {
                this.showToast('Video renamed successfully', 'success');
                this.loadVideos();
                this.closeRenameModal();
            } else {
                const error = await response.json();
                this.showToast(`Failed to rename: ${error.error}`, 'error');
            }
        } catch (error) {
            console.error('Rename error:', error);
            this.showToast('Failed to rename video', 'error');
        }
    }

    closeRenameModal() {
        document.getElementById('renameModal').classList.remove('show');
        this.currentRenameVideoId = null;
    }

    // Delete Video
    confirmDelete(videoId) {
        const video = this.videos.find(v => v.id === videoId);
        if (video) {
            this.currentDeleteVideoId = videoId;
            const modal = document.getElementById('deleteModal');
            const videoNameSpan = document.getElementById('deleteVideoName');
            
            videoNameSpan.textContent = video.originalName;
            modal.classList.add('show');
        }
    }

    async deleteVideo() {
        if (!this.currentDeleteVideoId) return;

        try {
            const response = await fetch(`/api/video/${this.currentDeleteVideoId}`, {
                method: 'DELETE'
            });

            if (response.ok) {
                this.showToast('Video deleted successfully', 'success');
                this.loadVideos();
                this.closeDeleteModal();
            } else {
                const error = await response.json();
                this.showToast(`Failed to delete: ${error.error}`, 'error');
            }
        } catch (error) {
            console.error('Delete error:', error);
            this.showToast('Failed to delete video', 'error');
        }
    }

    closeDeleteModal() {
        document.getElementById('deleteModal').classList.remove('show');
        this.currentDeleteVideoId = null;
    }

    // Backup Status
    updateBackupStatus() {
        // Update connection status indicator for new UI
        const statusIndicator = document.getElementById('connectionStatus');
        if (statusIndicator) {
            statusIndicator.style.backgroundColor = 'var(--accent-green)';
        }
    }

    syncBackup() {
        this.showToast('Syncing backup...', 'info');
        
        // Mock sync process
        setTimeout(() => {
            this.showToast('Backup synced successfully', 'success');
            this.updateBackupStatus();
        }, 2000);
    }

    // Utility Functions
    formatFileSize(bytes) {
        if (!bytes) return 'Unknown';
        
        const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
        if (bytes === 0) return '0 B';
        const i = parseInt(Math.floor(Math.log(bytes) / Math.log(1024)));
        return Math.round(bytes / Math.pow(1024, i) * 100) / 100 + ' ' + sizes[i];
    }

    showToast(message, type = 'info') {
        // Show in notification area only
        const notificationArea = document.getElementById('notificationArea');
        if (notificationArea) {
            const notificationText = notificationArea.querySelector('.notification-text');
            const notificationIcon = notificationArea.querySelector('.notification-icon');
            
            if (notificationText) {
                notificationText.textContent = message;
            }
            
            // Update icon based on type
            if (notificationIcon) {
                if (type === 'success') {
                    notificationIcon.innerHTML = `
                        <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/>
                        <polyline points="22 4 12 14.01 9 11.01"/>
                    `;
                    notificationIcon.style.color = 'var(--accent-green)';
                } else if (type === 'error') {
                    notificationIcon.innerHTML = `
                        <circle cx="12" cy="12" r="10"/>
                        <line x1="15" y1="9" x2="9" y2="15"/>
                        <line x1="9" y1="9" x2="15" y2="15"/>
                    `;
                    notificationIcon.style.color = '#ff4444';
                } else {
                    notificationIcon.innerHTML = `
                        <circle cx="12" cy="12" r="10"/>
                        <line x1="12" y1="16" x2="12" y2="12"/>
                        <circle cx="12" cy="8" r="0.5"/>
                    `;
                    notificationIcon.style.color = 'var(--text-secondary)';
                }
            }
            
            // Add type-specific styling
            notificationArea.className = 'notification-area show';
            if (type === 'success') {
                notificationArea.style.borderColor = 'var(--accent-green)';
            } else if (type === 'error') {
                notificationArea.style.borderColor = '#ff4444';
            } else {
                notificationArea.style.borderColor = 'var(--border-color)';
            }
            
            // Clear any existing timeout
            if (this.notificationTimeout) {
                clearTimeout(this.notificationTimeout);
            }
            
            // Set new timeout
            this.notificationTimeout = setTimeout(() => {
                notificationArea.classList.remove('show');
                notificationArea.style.borderColor = '';
            }, 3000);
        }
    }

    getToastIcon(type) {
        const icons = {
            success: 'check-circle',
            error: 'exclamation-circle',
            warning: 'exclamation-triangle',
            info: 'info-circle'
        };
        return icons[type] || 'info-circle';
    }
}

// Global app variable
let app;

// Global functions for HTML onclick events
function openUploadModal() {
    if (app) app.openUploadModal();
}

function closeUploadModal() {
    if (app) app.closeUploadModal();
}

function closePlayer() {
    if (app) app.closePlayer();
}

function syncBackup() {
    if (app) app.syncBackup();
}

function closeRenameModal() {
    if (app) app.closeRenameModal();
}

function closeDeleteModal() {
    if (app) app.closeDeleteModal();
}

// Initialize app when DOM is loaded
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => {
        app = new StreamDriveApp();
    });
} else {
    // DOM is already loaded
    app = new StreamDriveApp();
}
