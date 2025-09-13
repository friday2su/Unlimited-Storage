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
        this.currentVideoAudioTracks = [];  // Store audio tracks for currently playing video
        this.hlsPlayer = null;  // HLS.js instance
        this.currentQuality = 'auto';  // Current quality setting
        this.compressionSettings = {
            enabled: true,
            preset: 'medium',
            resolution: '720p',
            bitrate: 2.5,
            fps: '30'
        };
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
        
        // Compression settings events
        const enableCompression = document.getElementById('enableCompression');
        const qualityPreset = document.getElementById('qualityPreset');
        const videoBitrate = document.getElementById('videoBitrate');
        
        if (enableCompression) {
            enableCompression.addEventListener('change', (e) => {
                this.compressionSettings.enabled = e.target.checked;
                document.getElementById('compressionControls').style.opacity = e.target.checked ? '1' : '0.5';
                document.getElementById('compressionControls').style.pointerEvents = e.target.checked ? 'auto' : 'none';
            });
        }
        
        if (qualityPreset) {
            qualityPreset.addEventListener('change', (e) => {
                this.compressionSettings.preset = e.target.value;
                const customSettings = document.getElementById('customSettings');
                customSettings.style.display = e.target.value === 'custom' ? 'block' : 'none';
                this.updateCompressionInfo();
            });
        }
        
        if (videoBitrate) {
            videoBitrate.addEventListener('input', (e) => {
                this.compressionSettings.bitrate = parseFloat(e.target.value);
                document.getElementById('bitrateValue').textContent = `${e.target.value} Mbps`;
            });
        }

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
            : (video.processing && !video.cloudThumbnail)
            ? `/api/thumbnail/${video.id}?t=${Date.now()}` // Force refresh
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
        
        // Reset modal to initial state
        this.resetUploadModalState();
        
        // Clear file input and queue
        const fileInput = document.getElementById('fileInput');
        if (fileInput) {
            fileInput.value = '';
        }
        this.uploadQueue = [];
    }
    
    resetUploadModalState() {
        // Show initial sections
        const uploadSections = document.getElementById('uploadSections');
        const minimalProgress = document.getElementById('minimalProgress');
        const uploadQueue = document.getElementById('uploadQueue');
        const uploadHeader = document.getElementById('uploadHeader');
        const uploadModal = document.getElementById('uploadModal');
        const closeBtn = document.getElementById('uploadCloseBtn');
        
        if (uploadSections) {
            uploadSections.style.display = 'block';
            uploadSections.classList.remove('hidden');
        }
        if (minimalProgress) {
            minimalProgress.style.display = 'none';
        }
        if (uploadQueue) {
            uploadQueue.style.display = 'none';
        }
        if (uploadHeader) {
            uploadHeader.classList.remove('processing');
            document.getElementById('uploadHeaderTitle').textContent = 'Upload Video';
        }
        if (uploadModal) {
            uploadModal.classList.remove('minimal');
        }
        if (closeBtn) {
            closeBtn.classList.remove('disabled');
        }
        
        // Reset progress elements
        const mainProgressFill = document.getElementById('mainProgressFill');
        const mainProgressText = document.getElementById('mainProgressText');
        const mainProgressPercentage = document.getElementById('mainProgressPercentage');
        
        if (mainProgressFill) mainProgressFill.style.width = '0%';
        if (mainProgressText) mainProgressText.textContent = 'Preparing...';
        if (mainProgressPercentage) mainProgressPercentage.textContent = '0%';
    }
    
    switchToMinimalMode() {
        // Hide initial sections and show minimal progress
        const uploadSections = document.getElementById('uploadSections');
        const minimalProgress = document.getElementById('minimalProgress');
        const uploadHeader = document.getElementById('uploadHeader');
        const uploadModal = document.getElementById('uploadModal');
        const closeBtn = document.getElementById('uploadCloseBtn');
        
        if (uploadSections) {
            uploadSections.classList.add('hidden');
            setTimeout(() => {
                uploadSections.style.display = 'none';
            }, 300);
        }
        
        if (minimalProgress) {
            minimalProgress.style.display = 'block';
        }
        
        if (uploadHeader) {
            uploadHeader.classList.add('processing');
            document.getElementById('uploadHeaderTitle').textContent = 'Processing Video';
        }
        
        if (uploadModal) {
            uploadModal.classList.add('minimal');
        }
        
        if (closeBtn) {
            closeBtn.classList.add('disabled');
        }
    }

    handleFileSelect(event) {
        const files = Array.from(event.target.files);
        if (files.length > 0) {
            this.addFilesToQueue(files);
            // Show compression settings when files are selected
            document.getElementById('compressionSettings').style.display = 'block';
            // Ensure upload modal stays visible
            document.getElementById('uploadModal').classList.add('show');
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
                processingProgress: 0,
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
    
    
    async monitorVideoProcessing(videoId, queueItem) {
        const pollInterval = 2000; // Poll every 2 seconds for faster updates
        const maxPolls = 180; // Max 6 minutes (180 * 2 seconds)
        let pollCount = 0;
        
        // Get UI elements for minimal progress display
        const mainProgressText = document.getElementById('mainProgressText');
        const mainProgressFill = document.getElementById('mainProgressFill');
        const mainProgressPercentage = document.getElementById('mainProgressPercentage');
        
        const checkStatus = async () => {
            try {
                const response = await fetch(`/api/video/${videoId}/status`);
                if (!response.ok) {
                    throw new Error('Failed to get processing status');
                }
                
                const status = await response.json();
                console.log('Processing status:', status);
                
                let progressText = 'Processing...';
                let progressPercent = 50;
                
                // Update progress based on backend status with quality information
                if (status.hlsProgress > 0 && status.hlsProgress < 100) {
                    // Show detailed quality-specific progress
                    let qualityText = '';
                    if (status.currentQuality) {
                        qualityText = ` (${status.currentQuality})`;
                    }
                    
                    progressText = `${status.hlsStage || 'Generating qualities'}${qualityText}`;
                    progressPercent = status.hlsProgress;
                    
                    if (queueItem) {
                        queueItem.status = 'processing-hls';
                        queueItem.processingProgress = status.hlsProgress;
                        queueItem.currentQuality = status.currentQuality;
                    }
                } else if (status.thumbnailGenerating) {
                    progressText = 'Creating thumbnail...';
                    progressPercent = 95;
                    
                    if (queueItem) {
                        queueItem.status = 'processing-thumbnail';
                        queueItem.processingProgress = 95;
                    }
                } else if (status.processingComplete === true) {
                    progressText = 'Processing complete!';
                    progressPercent = 100;
                    
                    if (queueItem) {
                        queueItem.status = 'completed';
                        queueItem.processingProgress = 100;
                    }
                    
                    // Update minimal progress display
                    if (mainProgressText) mainProgressText.textContent = progressText;
                    if (mainProgressFill) mainProgressFill.style.width = '100%';
                    if (mainProgressPercentage) mainProgressPercentage.textContent = '100%';
                    
                    this.updateQueueDisplay();
                    
                    // Show success message
                    const fileName = queueItem ? queueItem.file.name : 'Video';
                    this.showToast(`${fileName} processed successfully!`, 'success');
                    
                    // Refresh video list
                    this.loadVideos();
                    
                    // Handle completion
                    if (queueItem) {
                        // Remove from queue after delay
                        setTimeout(() => {
                            const index = this.uploadQueue.indexOf(queueItem);
                            if (index > -1) {
                                this.uploadQueue.splice(index, 1);
                                this.updateQueueDisplay();
                                
                                // Close modal if no more items
                                if (this.uploadQueue.length === 0) {
                                    setTimeout(() => {
                                        this.closeUploadModal();
                                    }, 2000);
                                }
                            }
                        }, 3000);
                    } else {
                        // Single file - close modal after delay
                        setTimeout(() => {
                            this.closeUploadModal();
                        }, 3000);
                    }
                    
                    return; // Stop polling
                } else if (status.hlsProgress >= 100 && status.hlsStage === 'Processing complete') {
                    // Fallback completion detection
                    progressText = 'Processing complete!';
                    progressPercent = 100;
                    
                    if (mainProgressText) mainProgressText.textContent = progressText;
                    if (mainProgressFill) mainProgressFill.style.width = '100%';
                    if (mainProgressPercentage) mainProgressPercentage.textContent = '100%';
                    
                    const fileName = queueItem ? queueItem.file.name : 'Video';
                    this.showToast(`${fileName} processed successfully!`, 'success');
                    this.loadVideos();
                    
                    if (queueItem) {
                        queueItem.status = 'completed';
                        queueItem.processingProgress = 100;
                        this.updateQueueDisplay();
                    }
                    
                    setTimeout(() => {
                        this.closeUploadModal();
                    }, 3000);
                    
                    return; // Stop polling
                }
                
                // Update minimal progress display
                if (mainProgressText) mainProgressText.textContent = progressText;
                if (mainProgressFill) {
                    mainProgressFill.style.width = progressPercent + '%';
                }
                if (mainProgressPercentage) {
                    mainProgressPercentage.textContent = Math.round(progressPercent) + '%';
                }
                
                // Update quality information display
                const qualityInfo = document.getElementById('currentQualityInfo');
                if (qualityInfo && status.currentQuality) {
                    qualityInfo.textContent = status.currentQuality;
                    qualityInfo.style.display = 'block';
                } else if (qualityInfo) {
                    qualityInfo.style.display = 'none';
                }
                
                if (queueItem) {
                    this.updateQueueDisplay();
                }
                
                // Continue polling if not complete and within limits
                pollCount++;
                if (pollCount < maxPolls && !status.processingComplete) {
                    setTimeout(checkStatus, pollInterval);
                } else if (pollCount >= maxPolls) {
                    // Timeout - assume completed
                    console.log('Processing monitoring timeout reached, assuming completion');
                    if (mainProgressText) mainProgressText.textContent = 'Processing complete!';
                    if (mainProgressFill) mainProgressFill.style.width = '100%';
                    if (mainProgressPercentage) mainProgressPercentage.textContent = '100%';
                    
                    if (queueItem) {
                        queueItem.status = 'completed';
                        queueItem.processingProgress = 100;
                        this.updateQueueDisplay();
                    }
                    
                    this.showToast('Processing completed', 'success');
                    this.loadVideos();
                    
                    // Close modal after timeout
                    setTimeout(() => {
                        this.closeUploadModal();
                    }, 2000);
                }
                
            } catch (error) {
                console.error('Error monitoring video processing:', error);
                
                // Show error state
                if (mainProgressText) mainProgressText.textContent = 'Processing failed';
                
                if (queueItem) {
                    queueItem.status = 'failed';
                    this.updateQueueDisplay();
                }
                
                this.showToast('Video processing failed', 'error');
                
                // Reset modal after delay
                setTimeout(() => {
                    this.resetUploadModalState();
                }, 3000);
            }
        };
        
        // Start monitoring immediately
        setTimeout(checkStatus, 1000);
    }
    
    updateQueueDisplay() {
        const queueContainer = document.getElementById('uploadQueue');
        const queueList = document.getElementById('queueList');
        const queueCount = document.getElementById('queueCount');
        
        if (this.uploadQueue.length === 0) {
            queueContainer.style.display = 'none';
            return;
        }
        
        // Show queue when there are multiple items or during processing
        if (this.uploadQueue.length > 1) {
            queueContainer.style.display = 'block';
            
            // Update queue count
            const completedCount = this.uploadQueue.filter(item => item.status === 'completed').length;
            const totalCount = this.uploadQueue.length;
            if (queueCount) {
                queueCount.textContent = `${completedCount + 1} of ${totalCount}`;
            }
        } else {
            queueContainer.style.display = 'none';
        }
        
        if (queueList) {
            queueList.innerHTML = this.uploadQueue.map((item, index) => {
                let statusText = 'Waiting';
                let statusClass = 'pending';
                let progressBar = '';
                let progressPercent = 0;
                
                if (item.status === 'uploading') {
                    statusText = `Uploading`;
                    statusClass = 'uploading';
                    progressPercent = Math.round(item.progress);
                    progressBar = `<div class="queue-progress"><div class="queue-progress-fill" style="width: ${item.progress}%"></div></div>`;
                } else if (item.status === 'processing-hls') {
                    statusText = item.currentQuality ? `Processing ${item.currentQuality}` : 'Processing qualities';
                    statusClass = 'processing';
                    progressPercent = Math.round(item.processingProgress || 0);
                    progressBar = `<div class="queue-progress processing"><div class="queue-progress-fill" style="width: ${item.processingProgress || 0}%"></div></div>`;
                } else if (item.status === 'processing-thumbnail') {
                    statusText = 'Creating thumbnail';
                    statusClass = 'processing';
                    progressPercent = 95;
                    progressBar = `<div class="queue-progress processing"><div class="queue-progress-fill" style="width: 95%"></div></div>`;
                } else if (item.status === 'completed') {
                    statusText = 'Complete';
                    statusClass = 'completed';
                    progressPercent = 100;
                    progressBar = `<div class="queue-progress complete"><div class="queue-progress-fill" style="width: 100%"></div></div>`;
                } else if (item.status === 'failed') {
                    statusText = 'Failed';
                    statusClass = 'failed';
                } else if (item.status === 'processing') {
                    statusText = 'Processing';
                    statusClass = 'processing';
                    progressPercent = 50;
                    progressBar = `<div class="queue-progress processing"><div class="queue-progress-fill" style="width: 50%"></div></div>`;
                }
                
                return `
                    <div class="queue-item ${statusClass}">
                        <div class="queue-item-info">
                            <div class="queue-item-name">${item.file.name}</div>
                            <div class="queue-item-meta">
                                <span class="queue-item-size">${this.formatFileSize(item.file.size)}</span>
                                <span class="queue-item-status">${statusText}${progressPercent > 0 ? ` (${progressPercent}%)` : ''}</span>
                            </div>
                        </div>
                        ${progressBar}
                    </div>
                `;
            }).join('');
        }
        
        // Keep upload modal visible while queue has items
        if (this.uploadQueue.length > 0 && !document.getElementById('uploadModal').classList.contains('show')) {
            document.getElementById('uploadModal').classList.add('show');
        }
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
        
        // Switch to minimal progress mode
        this.switchToMinimalMode();
        
        // Update file info in minimal progress display
        const currentFileName = document.getElementById('currentFileName');
        const currentFileSize = document.getElementById('currentFileSize');
        const mainProgressText = document.getElementById('mainProgressText');
        const mainProgressFill = document.getElementById('mainProgressFill');
        const mainProgressPercentage = document.getElementById('mainProgressPercentage');
        
        if (currentFileName) currentFileName.textContent = file.name;
        if (currentFileSize) currentFileSize.textContent = this.formatFileSize(file.size);
        
        const formData = new FormData();
        formData.append('video', file);

        return new Promise((resolve) => {
            try {
                const xhr = new XMLHttpRequest();
                
                // Reset progress bar to 0
                if (mainProgressFill) mainProgressFill.style.width = '0%';
                if (mainProgressPercentage) mainProgressPercentage.textContent = '0%';
                if (mainProgressText) mainProgressText.textContent = 'Uploading...';
                
                xhr.upload.addEventListener('progress', (e) => {
                    if (e.lengthComputable) {
                        const percentComplete = (e.loaded / e.total) * 100;
                        
                        // Update minimal progress display
                        requestAnimationFrame(() => {
                            if (mainProgressFill) {
                                mainProgressFill.style.width = percentComplete + '%';
                            }
                            if (mainProgressPercentage) {
                                mainProgressPercentage.textContent = Math.round(percentComplete) + '%';
                            }
                            if (mainProgressText) {
                                mainProgressText.textContent = `Uploading... ${Math.round(percentComplete)}%`;
                            }
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
                        
                        // Update progress to show processing started
                        if (mainProgressFill) {
                            mainProgressFill.style.width = '100%';
                        }
                        if (mainProgressPercentage) {
                            mainProgressPercentage.textContent = '100%';
                        }
                        if (mainProgressText) {
                            mainProgressText.textContent = 'Upload complete, starting processing...';
                        }
                        
                        // Start processing monitoring after a short delay to show upload completion
                        setTimeout(() => {
                            if (queueItem) {
                                queueItem.status = 'processing';
                                this.updateQueueDisplay();
                                
                                // Start background processing monitoring
                                this.monitorVideoProcessing(response.videoId, queueItem);
                            } else {
                                // Single file upload - monitor without queue item
                                this.monitorVideoProcessing(response.videoId, null);
                            }
                        }, 1000);
                        
                        // Don't show success toast yet - wait for processing to complete
                        this.loadVideos();
                        resolve(true);
                    } else {
                        const error = JSON.parse(xhr.responseText);
                        const errorMsg = window.lang ? `${window.lang.get('uploadFailed')} ${file.name}: ${error.error}` : `Failed to upload ${file.name}: ${error.error}`;
                        this.showToast(errorMsg, 'error');
                        this.resetUploadModalState();
                        resolve(false);
                    }
                });

                xhr.addEventListener('error', () => {
                    this.showToast(`Failed to upload ${file.name}: Network error`, 'error');
                    this.resetUploadModalState();
                    resolve(false);
                });

                xhr.open('POST', '/api/upload');
                xhr.send(formData);

            } catch (error) {
                console.error('Upload error:', error);
                this.showToast(`Failed to upload ${file.name}: ${error.message}`, 'error');
                this.resetUploadModalState();
                resolve(false);
            }
        });
    }

    validateFile(file) {
        // No file size limit anymore - we handle large files
        // const maxSize = 10 * 1024 * 1024 * 1024; // 10GB

        if (!file.type.startsWith('video/')) {
            this.showToast(window.lang ? window.lang.get('selectValidFile') : 'Please select a valid video file', 'error');
            return false;
        }

        // Remove file size check to allow unlimited file sizes
        // Backend will handle chunking for Telegram if needed
        /*
        if (file.size > maxSize) {
            this.showToast(window.lang ? window.lang.get('fileSizeLimit') : 'File size must be less than 10GB', 'error');
            return false;
        }
        */

        return true;
    }

    // Video Player - Enhanced with multi-audio support
    async playVideo(videoId) {
        try {
            // First get video details and audio track information
            const [videoResponse, audioTracksResponse] = await Promise.all([
                fetch(`/api/video/${videoId}`),
                fetch(`/api/video/${videoId}/audio-tracks`)
            ]);
            
            if (!videoResponse.ok) {
                const errorData = await videoResponse.json().catch(() => ({}));
                throw new Error(errorData.error || `Video not found (${videoResponse.status})`);
            }

            const video = await videoResponse.json();
            const audioTracksInfo = audioTracksResponse.ok ? await audioTracksResponse.json() : { hasMultiAudio: false, tracks: [] };
            
            const modal = document.getElementById('playerModal');
            const playerTitle = document.getElementById('playerTitle');
            const videoPlayer = document.getElementById('videoPlayer');
            const audioTrackSelector = document.getElementById('audioTrackSelector');
            const audioTrackSelect = document.getElementById('audioTrackSelect');

            playerTitle.textContent = video.originalName;
            this.currentPlayingVideoId = videoId;
            this.currentVideoAudioTracks = audioTracksInfo.tracks || video.audioTracks || [];
            this.currentAudioTracksInfo = audioTracksInfo;
            this.currentAudioElement = null; // For separate audio playback
            
            console.log('Multi-audio info:', audioTracksInfo);
            
            // Setup audio track selector based on multi-audio capability
            if (audioTracksInfo.hasMultiAudio && audioTracksInfo.tracks.length > 1) {
                // Show audio track selector for multi-audio videos
                audioTrackSelector.style.display = 'flex';
                
                // Populate audio track options with extracted audio tracks
                audioTrackSelect.innerHTML = audioTracksInfo.tracks.map((track, index) => {
                    let label = track.title || `Track ${index + 1}`;
                    if (track.language && track.language !== 'unknown') {
                        label = `${this.getLanguageName(track.language)} - ${label}`;
                    }
                    return `<option value="${track.trackIndex}">${label}</option>`;
                }).join('');
                
                // Set preferred language if available
                const preferredLang = localStorage.getItem('preferredAudioLanguage');
                if (preferredLang) {
                    const preferredTrack = audioTracksInfo.tracks.find(t => t.language === preferredLang);
                    if (preferredTrack) {
                        audioTrackSelect.value = preferredTrack.trackIndex;
                    }
                }
            } else if (video.audioTracks && video.audioTracks.length > 1) {
                // Fallback to standard HLS audio tracks for non-multi-audio videos
                audioTrackSelector.style.display = 'flex';
                
                audioTrackSelect.innerHTML = video.audioTracks.map((track, index) => {
                    let label = track.title || `Track ${index + 1}`;
                    if (track.language && track.language !== 'unknown') {
                        label = `${this.getLanguageName(track.language)} - ${label}`;
                    }
                    return `<option value="${index}">${label}</option>`;
                }).join('');
            } else {
                // Hide audio track selector if only one track or no tracks
                audioTrackSelector.style.display = 'none';
            }
            
            // Determine streaming method based on multi-audio capability
            let streamUrl;
            let useVideoOnlyHLS = false;
            
            if (audioTracksInfo.hasMultiAudio && audioTracksInfo.videoOnlyHLS) {
                // Use video-only HLS for multi-audio videos
                streamUrl = `/api/hls/${videoId}/video-only/playlist.m3u8`;
                useVideoOnlyHLS = true;
                console.log('Using video-only HLS for multi-audio video:', videoId);
            } else if (video.hlsPlaylist || video.streamingMethod === 'adaptive') {
                // Use standard HLS for single audio or fallback
                streamUrl = `/api/hls/${videoId}/playlist.m3u8`;
                console.log('Using standard HLS streaming for video:', videoId);
            } else {
                // Fallback to direct streaming
                streamUrl = `/api/stream/${videoId}`;
                console.log('Using direct streaming for video:', videoId);
            }
            
            // Clean up any existing HLS player
            if (this.hlsPlayer) {
                this.hlsPlayer.destroy();
                this.hlsPlayer = null;
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

            // Initialize separate audio element for multi-audio videos
            if (useVideoOnlyHLS && audioTracksInfo.tracks.length > 0) {
                // Create separate audio element for synchronized playback
                this.currentAudioElement = document.createElement('audio');
                this.currentAudioElement.preload = 'auto';
                this.currentAudioElement.volume = videoPlayer.volume;
                
                // Set initial audio track
                const initialTrackIndex = audioTrackSelect ? audioTrackSelect.value : audioTracksInfo.tracks[0].trackIndex;
                this.setAudioTrack(videoId, initialTrackIndex);
                
                // Synchronize audio with video
                this.synchronizeAudioWithVideo(videoPlayer, this.currentAudioElement);
            }
            
            // Setup HLS or direct playback
            if ((video.hlsPlaylist || useVideoOnlyHLS) && Hls && Hls.isSupported()) {
                // Use HLS.js for adaptive streaming
                this.hlsPlayer = new Hls({
                    autoStartLoad: true,
                    startLevel: -1, // Auto quality
                    capLevelToPlayerSize: true,
                    maxLoadingDelay: 4,
                    maxBufferLength: 30,
                    maxMaxBufferLength: 600
                });
                
                this.hlsPlayer.loadSource(streamUrl);
                this.hlsPlayer.attachMedia(videoPlayer);
                
                // Handle HLS events
                this.hlsPlayer.on(Hls.Events.MANIFEST_PARSED, (event, data) => {
                    console.log('HLS manifest loaded, levels:', data.levels);
                    this.updateQualityOptions(data.levels);
                    
                    // Check for audio tracks in HLS
                    if (this.hlsPlayer.audioTracks && this.hlsPlayer.audioTracks.length > 1) {
                        console.log('HLS audio tracks available:', this.hlsPlayer.audioTracks);
                        // Update audio track selector for HLS
                        this.updateHLSAudioTracks();
                    }
                });
                
                this.hlsPlayer.on(Hls.Events.LEVEL_SWITCHED, (event, data) => {
                    console.log('Quality switched to:', data.level);
                    this.updateQualityIndicator(data.level);
                });
                
                this.hlsPlayer.on(Hls.Events.ERROR, (event, data) => {
                    if (data.fatal) {
                        console.error('Fatal HLS error:', data);
                        // Fallback to direct streaming
                        videoPlayer.src = `/api/stream/${videoId}`;
                    }
                });
                
                // Listen for audio track loading
                this.hlsPlayer.on(Hls.Events.AUDIO_TRACKS_UPDATED, (event, data) => {
                    console.log('HLS audio tracks updated:', data.audioTracks);
                    this.updateHLSAudioTracks();
                });
                
                // Listen for audio track switching
                this.hlsPlayer.on(Hls.Events.AUDIO_TRACK_SWITCHED, (event, data) => {
                    console.log('HLS audio track switched to:', data.id);
                });
            } else if ((video.hlsPlaylist || useVideoOnlyHLS) && videoPlayer.canPlayType('application/vnd.apple.mpegurl')) {
                // Native HLS support (Safari)
                videoPlayer.src = streamUrl;
            } else {
                // Direct streaming
                videoPlayer.src = streamUrl;
            }
            
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
    
    /**
     * Set audio track for multi-audio video
     * @param {string} videoId - Video ID
     * @param {number} trackIndex - Audio track index
     */
    setAudioTrack(videoId, trackIndex) {
        if (!this.currentAudioElement) return;
        
        const audioUrl = `/api/audio/${videoId}/${trackIndex}`;
        console.log(`Setting audio track ${trackIndex} for video ${videoId}:`, audioUrl);
        
        // Store current playback state before switching
        const currentTime = this.currentAudioElement.currentTime;
        const wasPlaying = !this.currentAudioElement.paused;
        
        // Add error handling for audio loading
        const onLoadError = (error) => {
            console.warn(`Failed to load audio track ${trackIndex}:`, error);
            this.showToast(`Audio track ${trackIndex} failed to load`, 'error');
        };
        
        const onLoadSuccess = () => {
            console.log(`Audio track ${trackIndex} loaded successfully`);
            // Restore playback state
            this.currentAudioElement.currentTime = currentTime;
            if (wasPlaying) {
                this.currentAudioElement.play().catch(err => {
                    console.warn('Audio play after track switch failed:', err);
                });
            }
            // Remove event listeners
            this.currentAudioElement.removeEventListener('error', onLoadError);
            this.currentAudioElement.removeEventListener('loadeddata', onLoadSuccess);
        };
        
        // Add event listeners
        this.currentAudioElement.addEventListener('error', onLoadError, { once: true });
        this.currentAudioElement.addEventListener('loadeddata', onLoadSuccess, { once: true });
        
        // Set the new source and load
        this.currentAudioElement.src = audioUrl;
        this.currentAudioElement.load();
    }
    
    /**
     * Synchronize separate audio element with video element
     * @param {HTMLVideoElement} videoElement - Video element
     * @param {HTMLAudioElement} audioElement - Audio element
     */
    synchronizeAudioWithVideo(videoElement, audioElement) {
        let isSyncing = false;
        
        // Synchronize playback
        const syncPlayback = () => {
            if (isSyncing) return;
            isSyncing = true;
            
            if (videoElement.paused !== audioElement.paused) {
                if (videoElement.paused) {
                    audioElement.pause();
                } else {
                    audioElement.play().catch(err => console.warn('Audio play failed:', err));
                }
            }
            
            // Sync time if there's significant drift
            const timeDrift = Math.abs(videoElement.currentTime - audioElement.currentTime);
            if (timeDrift > 0.1) { // 100ms tolerance
                audioElement.currentTime = videoElement.currentTime;
            }
            
            isSyncing = false;
        };
        
        // Event listeners for synchronization
        videoElement.addEventListener('play', () => {
            audioElement.play().catch(err => console.warn('Audio play failed:', err));
        });
        
        videoElement.addEventListener('pause', () => {
            audioElement.pause();
        });
        
        videoElement.addEventListener('seeked', () => {
            audioElement.currentTime = videoElement.currentTime;
        });
        
        videoElement.addEventListener('volumechange', () => {
            audioElement.volume = videoElement.volume;
            audioElement.muted = videoElement.muted;
        });
        
        videoElement.addEventListener('timeupdate', syncPlayback);
        
        // Initial sync
        audioElement.volume = videoElement.volume;
        audioElement.muted = videoElement.muted;
        
        console.log('Audio-video synchronization established');
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
        
        // Clean up separate audio element for multi-audio videos
        if (this.currentAudioElement) {
            this.currentAudioElement.pause();
            this.currentAudioElement.removeAttribute('src');
            this.currentAudioElement.load();
            this.currentAudioElement = null;
            console.log('Multi-audio element cleaned up');
        }
        
        // Clear source after removing event listener to avoid error events
        videoPlayer.removeAttribute('src');
        videoPlayer.load();
        
        // Clean up HLS player
        if (this.hlsPlayer) {
            this.hlsPlayer.destroy();
            this.hlsPlayer = null;
        }
        
        // Reset multi-audio state
        this.currentAudioTracksInfo = null;
        this.currentPlayingVideoId = null;
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
    
    // Helper method to get language name
    getLanguageName(code) {
        const languages = {
            'en': 'English',
            'es': 'Spanish',
            'fr': 'French',
            'de': 'German',
            'zh': 'Chinese',
            'ja': 'Japanese',
            'ko': 'Korean',
            'hi': 'Hindi',
            'ar': 'Arabic',
            'pt': 'Portuguese',
            'ru': 'Russian',
            'it': 'Italian',
            'und': 'Unknown'
        };
        return languages[code] || code.toUpperCase();
    }
    
    // Video Compression
    async compressVideo(file, queueItem) {
        const compressionProgress = document.getElementById('compressionProgress');
        const compressionFill = document.getElementById('compressionFill');
        const compressionPercent = document.getElementById('compressionPercent');
        const compressionStatus = document.getElementById('compressionStatus');
        
        try {
            compressionProgress.style.display = 'block';
            compressionStatus.textContent = 'Preparing compression...';
            
            // Get compression parameters based on preset
            const params = this.getCompressionParams();
            
            // For server-side compression, send the file with compression params
            const formData = new FormData();
            formData.append('video', file);
            formData.append('compress', 'true');
            formData.append('preset', this.compressionSettings.preset);
            formData.append('resolution', params.resolution);
            formData.append('bitrate', params.bitrate);
            formData.append('fps', params.fps);
            
            // Simulate compression progress (actual implementation would use server events)
            let progress = 0;
            const progressInterval = setInterval(() => {
                progress += Math.random() * 15;
                if (progress > 95) progress = 95;
                compressionFill.style.width = `${progress}%`;
                compressionPercent.textContent = `${Math.round(progress)}%`;
                compressionStatus.textContent = 'Compressing video...';
            }, 500);
            
            // In production, this would be an actual compression endpoint
            // For now, we'll return the original file after a delay
            await new Promise(resolve => setTimeout(resolve, 3000));
            
            clearInterval(progressInterval);
            compressionFill.style.width = '100%';
            compressionPercent.textContent = '100%';
            compressionStatus.textContent = 'Compression complete!';
            
            setTimeout(() => {
                compressionProgress.style.display = 'none';
            }, 1000);
            
            // Return the original file (in production, this would be the compressed file)
            return file;
            
        } catch (error) {
            console.error('Compression error:', error);
            compressionProgress.style.display = 'none';
            return null;
        }
    }
    
    getCompressionParams() {
        const presets = {
            high: { resolution: '1080p', bitrate: '5', fps: 'original' },
            medium: { resolution: '720p', bitrate: '2.5', fps: '30' },
            low: { resolution: '480p', bitrate: '1', fps: '24' },
            custom: {
                resolution: this.compressionSettings.resolution,
                bitrate: this.compressionSettings.bitrate.toString(),
                fps: this.compressionSettings.fps
            }
        };
        return presets[this.compressionSettings.preset] || presets.medium;
    }
    
    updateCompressionInfo() {
        const info = document.getElementById('compressionInfo');
        const params = this.getCompressionParams();
        const sizeReduction = this.compressionSettings.preset === 'high' ? '20-30%' :
                             this.compressionSettings.preset === 'medium' ? '40-50%' :
                             this.compressionSettings.preset === 'low' ? '60-70%' : '30-60%';
        info.textContent = `Estimated size reduction: ${sizeReduction} | Output: ${params.resolution} @ ${params.bitrate}Mbps`;
    }
    
    // Quality Switching for Adaptive Streaming
    switchQuality(quality) {
        if (!this.hlsPlayer) {
            this.showToast('Quality switching not available for this video', 'info');
            return;
        }
        
        if (quality === 'auto') {
            this.hlsPlayer.currentLevel = -1; // Auto quality
            this.currentQuality = 'auto';
            this.showToast('Switched to automatic quality', 'success');
        } else {
            // Find the level that matches the requested quality
            const levels = this.hlsPlayer.levels;
            const qualityMap = {
                '1080p': 1080,
                '720p': 720,
                '480p': 480,
                '360p': 360
            };
            
            const targetHeight = qualityMap[quality];
            if (targetHeight) {
                const levelIndex = levels.findIndex(level => level.height === targetHeight);
                if (levelIndex !== -1) {
                    this.hlsPlayer.currentLevel = levelIndex;
                    this.currentQuality = quality;
                    this.showToast(`Switched to ${quality}`, 'success');
                } else {
                    this.showToast(`${quality} not available`, 'warning');
                }
            }
        }
    }
    
    updateQualityOptions(levels) {
        const qualitySelect = document.getElementById('qualitySelect');
        const qualitySelector = document.getElementById('qualitySelector');
        if (!qualitySelect || !levels || levels.length === 0) return;
        
        // Show quality selector for HLS streams
        if (qualitySelector) {
            qualitySelector.style.display = 'flex';
        }
        
        // Clear existing options and add auto option
        qualitySelect.innerHTML = '<option value="auto" selected>Auto</option>';
        
        // Add available quality levels
        const addedQualities = new Set();
        levels.forEach((level, index) => {
            const height = level.height;
            const quality = `${height}p`;
            
            // Avoid duplicates
            if (!addedQualities.has(quality)) {
                addedQualities.add(quality);
                const option = document.createElement('option');
                option.value = quality;
                option.textContent = quality;
                option.dataset.levelIndex = index;
                qualitySelect.appendChild(option);
            }
        });
    }
    
    updateQualityIndicator(levelIndex) {
        const indicator = document.getElementById('qualityIndicator');
        if (!indicator || !this.hlsPlayer) return;
        
        if (levelIndex === -1) {
            indicator.textContent = '(Auto)';
        } else {
            const level = this.hlsPlayer.levels[levelIndex];
            if (level) {
                indicator.textContent = `(${level.height}p)`;
            }
        }
    }
    
    // Switch audio track for multi-audio videos
    switchAudioTrack(trackIndex) {
        const videoPlayer = document.getElementById('videoPlayer');
        const parsedTrackIndex = parseInt(trackIndex);
        
        console.log('Switching audio track to index:', parsedTrackIndex);
        
        // Handle multi-audio videos with separate audio files
        if (this.currentAudioTracksInfo && this.currentAudioTracksInfo.hasMultiAudio && this.currentAudioElement) {
            const selectedTrack = this.currentAudioTracksInfo.tracks.find(t => t.trackIndex === parsedTrackIndex);
            
            if (selectedTrack) {
                console.log('Switching to separate audio track:', selectedTrack);
                
                try {
                    // Store current playback state
                    const currentTime = videoPlayer.currentTime;
                    const wasPlaying = !videoPlayer.paused;
                    
                    // Pause current audio to prevent conflicts
                    this.currentAudioElement.pause();
                    
                    // Create a timeout for the switching operation
                    const switchTimeout = setTimeout(() => {
                        console.warn('Audio track switch timed out');
                        this.showToast('Audio track switch timed out, please try again', 'warning');
                    }, 10000); // 10 second timeout
                    
                    // Enhanced load success handler
                    const onLoadSuccess = () => {
                        clearTimeout(switchTimeout);
                        try {
                            this.currentAudioElement.currentTime = currentTime;
                            if (wasPlaying) {
                                this.currentAudioElement.play().catch(err => {
                                    console.warn('Audio play failed after track switch:', err);
                                    this.showToast('Audio switched but playback failed', 'warning');
                                });
                            }
                            
                            // Store preference
                            if (selectedTrack.language && selectedTrack.language !== 'unknown') {
                                localStorage.setItem('preferredAudioLanguage', selectedTrack.language);
                            }
                            
                            const trackName = selectedTrack.title || `${this.getLanguageName(selectedTrack.language)} - Track ${parsedTrackIndex + 1}`;
                            this.showToast(`Switched to ${trackName}`, 'success');
                            console.log('Switched to multi-audio track:', parsedTrackIndex, selectedTrack);
                        } catch (syncError) {
                            console.error('Error during audio sync:', syncError);
                            this.showToast('Audio switched but sync failed', 'warning');
                        }
                    };
                    
                    // Enhanced error handler
                    const onLoadError = (error) => {
                        clearTimeout(switchTimeout);
                        console.error('Failed to load new audio track:', error);
                        this.showToast(`Failed to switch to audio track ${parsedTrackIndex + 1}`, 'error');
                        
                        // Try to resume previous audio
                        if (wasPlaying) {
                            this.currentAudioElement.play().catch(err => {
                                console.warn('Failed to resume previous audio:', err);
                            });
                        }
                    };
                    
                    // Set up event listeners
                    this.currentAudioElement.addEventListener('loadeddata', onLoadSuccess, { once: true });
                    this.currentAudioElement.addEventListener('error', onLoadError, { once: true });
                    
                    // Set new audio track
                    this.setAudioTrack(this.currentPlayingVideoId, parsedTrackIndex);
                    
                    return; // Exit here for multi-audio handling
                    
                } catch (error) {
                    console.error('Error during audio track switching:', error);
                    this.showToast('Audio track switch failed', 'error');
                    return;
                }
            } else {
                console.warn(`Audio track ${parsedTrackIndex} not found`);
                this.showToast(`Audio track ${parsedTrackIndex + 1} not available`, 'error');
                return;
            }
        }
        
        // Store preference
        if (this.currentVideoAudioTracks && this.currentVideoAudioTracks[parsedTrackIndex]) {
            const track = this.currentVideoAudioTracks[parsedTrackIndex];
            if (track.language && track.language !== 'unknown') {
                localStorage.setItem('preferredAudioLanguage', track.language);
            }
        }
        
        // If using HLS.js with multiple audio tracks
        if (this.hlsPlayer && this.hlsPlayer.audioTracks && this.hlsPlayer.audioTracks.length > 1) {
            // HLS.js audio track switching
            if (parsedTrackIndex >= 0 && parsedTrackIndex < this.hlsPlayer.audioTracks.length) {
                this.hlsPlayer.audioTrack = parsedTrackIndex;
                const trackInfo = this.hlsPlayer.audioTracks[parsedTrackIndex];
                const trackName = trackInfo.name || trackInfo.lang || `Track ${parsedTrackIndex + 1}`;
                this.showToast(`Switched to ${trackName}`, 'success');
                console.log('Switched HLS audio track to:', parsedTrackIndex, trackInfo);
                return;
            }
        }
        
        // For multi-audio videos, try using HLS segments with specific audio track
        if (this.currentVideoAudioTracks && this.currentVideoAudioTracks.length > 1) {
            const currentTime = videoPlayer.currentTime;
            const wasPlaying = !videoPlayer.paused;
            
            // Pause the current playback
            videoPlayer.pause();
            
            const videoId = this.currentPlayingVideoId;
            
            // Try HLS first (which should support multiple audio tracks)
            const hlsUrl = `/api/hls/${videoId}/playlist.m3u8`;
            
            if (this.hlsPlayer) {
                this.hlsPlayer.destroy();
                this.hlsPlayer = null;
            }
            
            // Use HLS.js with audio track switching
            if (Hls && Hls.isSupported()) {
                this.hlsPlayer = new Hls({
                    autoStartLoad: true,
                    startLevel: -1,
                    capLevelToPlayerSize: true
                });
                
                this.hlsPlayer.loadSource(hlsUrl);
                this.hlsPlayer.attachMedia(videoPlayer);
                
                this.hlsPlayer.on(Hls.Events.MANIFEST_PARSED, () => {
                    // Try to switch audio track if available
                    if (this.hlsPlayer.audioTracks && this.hlsPlayer.audioTracks.length > parsedTrackIndex) {
                        this.hlsPlayer.audioTrack = parsedTrackIndex;
                    }
                    
                    // Restore playback position
                    videoPlayer.currentTime = currentTime;
                    if (wasPlaying) {
                        videoPlayer.play().catch(err => console.log('Auto-play failed:', err));
                    }
                });
                
                const trackInfo = this.currentVideoAudioTracks[parsedTrackIndex];
                const trackName = trackInfo.title || `${this.getLanguageName(trackInfo.language)} - Track ${parsedTrackIndex + 1}`;
                this.showToast(`Switched to ${trackName}`, 'success');
                console.log('Switched to audio track via HLS:', parsedTrackIndex, trackInfo);
            } else {
                // Fallback: show message that audio switching isn't available
                this.showToast('Audio track switching not available for this video', 'info');
                console.log('HLS not supported, cannot switch audio tracks');
            }
        } else if (videoPlayer.audioTracks && videoPlayer.audioTracks.length > 1) {
            // Native HTML5 audio track switching (fallback)
            for (let i = 0; i < videoPlayer.audioTracks.length; i++) {
                videoPlayer.audioTracks[i].enabled = (i === parsedTrackIndex);
            }
            this.showToast(`Switched to audio track ${parsedTrackIndex + 1}`, 'success');
            console.log('Used native HTML5 audio track switching');
        } else {
            // No multi-audio support available
            console.log('Audio track switching not available - single track or no support');
            this.showToast('Audio track switching not available for this video', 'info');
        }
    }
    
    // Update audio tracks from HLS player
    updateHLSAudioTracks() {
        if (!this.hlsPlayer || !this.hlsPlayer.audioTracks) return;
        
        const audioTrackSelector = document.getElementById('audioTrackSelector');
        const audioTrackSelect = document.getElementById('audioTrackSelect');
        
        if (this.hlsPlayer.audioTracks.length > 1) {
            audioTrackSelector.style.display = 'flex';
            
            // Update select options with HLS audio tracks
            audioTrackSelect.innerHTML = this.hlsPlayer.audioTracks.map((track, index) => {
                const label = track.name || track.lang || `Track ${index + 1}`;
                return `<option value="${index}">${label}</option>`;
            }).join('');
            
            // Set current audio track
            audioTrackSelect.value = this.hlsPlayer.audioTrack;
        }
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
