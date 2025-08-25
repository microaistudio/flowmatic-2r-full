// terminal-client.js - Connects the terminal UI to your existing FlowMatic-SOLO R2 backend

// Configuration - adjust these to match your server
const CONFIG = {
    API_BASE: `${window.location.protocol}//${window.location.host}/api`,  // Dynamic API endpoint
    SOCKET_URL: `${window.location.protocol}//${window.location.host}`,    // Dynamic Socket.IO server
    NAMESPACE: '/terminal'                   // Terminal namespace from architecture
};

// Terminal Application
class FlowMaticTerminal {
    constructor() {
        this.session = null;
        this.currentTicket = null;
        this.socket = null;
        this.serviceTimer = null;
        this.sessionTimer = null;
        this.selectedService = 1;
        this.selectedPriority = 0;
        
        this.initializeElements();
        this.checkExistingSession();
    }
    
    initializeElements() {
        // Screens
        this.loginScreen = document.getElementById('loginScreen');
        this.terminalScreen = document.getElementById('terminalScreen');
        
        // Forms and inputs
        this.loginForm = document.getElementById('loginForm');
        this.serviceSelector = document.getElementById('serviceSelector');
        
        // Display areas
        this.queueList = document.getElementById('queueList');
        this.queueCount = document.getElementById('queueCount');
        this.noTicket = document.getElementById('noTicket');
        this.ticketDisplay = document.getElementById('ticketDisplay');
        
        // Panels
        this.activityPanel = document.getElementById('activityPanel');
        this.statsPanel = document.getElementById('statsPanel');
        this.messagesPanel = document.getElementById('messagesPanel');
        
        // Buttons
        this.actionButtons = {
            next: document.getElementById('btnNext'),
            recall: document.getElementById('btnRecall'),
            end: document.getElementById('btnEnd'),
            noShow: document.getElementById('btnNoShow'),
            recycle: document.getElementById('btnRecycle'),
            park: document.getElementById('btnPark'),
            transfer: document.getElementById('btnTransfer'),
            openClose: document.getElementById('btnOpenClose')
        };
        
        this.setupEventListeners();
    }
    
    setupEventListeners() {
        // Login form
        this.loginForm.addEventListener('submit', (e) => this.handleLogin(e));
        
        // Service selector
        this.serviceSelector.addEventListener('change', (e) => this.handleServiceChange(e));
        
        // Priority toggle
        document.querySelectorAll('.toggle-btn').forEach(btn => {
            btn.addEventListener('click', (e) => this.handlePriorityToggle(e));
        });
        
        // Action buttons
        this.actionButtons.next.addEventListener('click', () => this.callNext());
        this.actionButtons.recall.addEventListener('click', () => this.recall());
        this.actionButtons.end.addEventListener('click', () => this.complete());
        this.actionButtons.noShow.addEventListener('click', () => this.noShow());
        this.actionButtons.recycle.addEventListener('click', () => this.recycle());
        this.actionButtons.park.addEventListener('click', () => this.park());
        this.actionButtons.transfer.addEventListener('click', () => this.transfer());
        this.actionButtons.openClose.addEventListener('click', () => this.toggleCounter());
        
        // Panel tabs
        document.querySelectorAll('.panel-tab').forEach(tab => {
            tab.addEventListener('click', (e) => this.switchPanel(e));
        });
        
        // Logout
        document.getElementById('logoutBtn').addEventListener('click', () => this.logout());
    }
    
    async handleLogin(e) {
        e.preventDefault();
        
        const formData = {
            username: document.getElementById('username').value,
            password: document.getElementById('password').value,
            counterId: parseInt(document.getElementById('counterId').value)
        };
        
        try {
            const response = await fetch(`${CONFIG.API_BASE}/terminal/login`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(formData)
            });
            
            if (!response.ok) {
                throw new Error('Login failed');
            }
            
            const data = await response.json();
            this.session = data.session;
            
            // Store session
            localStorage.setItem('flowmatic_session', JSON.stringify(this.session));
            
            // Initialize terminal
            this.initializeTerminal();
            
        } catch (error) {
            this.showNotification('Login failed. Please check your credentials.', 'error');
        }
    }
    
    initializeTerminal() {
        // Show terminal screen
        this.loginScreen.style.display = 'none';
        this.terminalScreen.classList.add('active');
        
        // Update UI with session info
        document.getElementById('agentName').textContent = this.session.agent.name;
        document.getElementById('agentRole').textContent = `${this.session.agent.role} • Level 5`;
        document.getElementById('counterStatus').textContent = `Counter ${this.session.counter.number || this.session.counter.id} Active`;
        
        // Start session timer
        this.startSessionTimer();
        
        // Connect to Socket.IO
        this.connectSocket();
        
        // Load initial data
        this.loadQueue();
        this.loadStats();
    }
    
    connectSocket() {
        this.socket = io(`${CONFIG.SOCKET_URL}${CONFIG.NAMESPACE}`);
        
        this.socket.on('connect', () => {
            console.log('Connected to FlowMatic server');
            this.updateConnectionStatus(true);
            
            // Join service room
            this.socket.emit('join-service', this.selectedService);
        });
        
        this.socket.on('disconnect', () => {
            console.log('Disconnected from server');
            this.updateConnectionStatus(false);
        });
        
        // Real-time event handlers based on architecture spec
        this.socket.on('ticket-created', (data) => this.handleTicketCreated(data));
        this.socket.on('ticket-called', (data) => this.handleTicketCalled(data));
        this.socket.on('ticket-completed', (data) => this.handleTicketCompleted(data));
        this.socket.on('ticket-parked', (data) => this.handleTicketParked(data));
        this.socket.on('ticket-recycled', (data) => this.handleTicketRecycled(data));
        this.socket.on('ticket-transferred', (data) => this.handleTicketTransferred(data));
        this.socket.on('queue-updated', (data) => this.handleQueueUpdated(data));
        this.socket.on('counter-updated', (data) => this.handleCounterUpdated(data));
        this.socket.on('system-alert', (data) => this.handleSystemAlert(data));
    }
    
    updateConnectionStatus(connected) {
        const dots = document.querySelectorAll('.status-dot');
        const connectionText = document.getElementById('connectionText');
        
        dots.forEach(dot => {
            if (connected) {
                dot.classList.remove('disconnected');
            } else {
                dot.classList.add('disconnected');
            }
        });
        
        connectionText.textContent = connected 
            ? 'Connected • Real-time sync active' 
            : 'Disconnected • Attempting to reconnect...';
    }
    
    async loadQueue() {
        try {
            const url = `${CONFIG.API_BASE}/terminal/queue/${this.selectedService}`;
            const response = await fetch(url);
            
            if (!response.ok) throw new Error('Failed to load queue');
            
            const data = await response.json();
            this.displayQueue(data.tickets || []);
            
        } catch (error) {
            console.error('Failed to load queue:', error);
            this.showNotification('Failed to load queue', 'error');
        }
    }
    
    displayQueue(tickets) {
        this.queueList.innerHTML = '';
        this.queueCount.textContent = tickets.length;
        
        // Filter by priority if selected
        const filteredTickets = this.selectedPriority > 0 
            ? tickets.filter(t => t.priority === this.selectedPriority)
            : tickets;
        
        filteredTickets.forEach((ticket, index) => {
            const waitMinutes = Math.floor((Date.now() - new Date(ticket.created_at).getTime()) / 60000);
            
            const item = document.createElement('div');
            item.className = `queue-item animate-in ${ticket.priority > 0 ? 'priority' : ''}`;
            item.innerHTML = `
                <div class="queue-number">${ticket.ticket_number}</div>
                <div class="queue-meta">
                    <span>Wait: ${waitMinutes} min</span>
                    <span>${ticket.priority > 0 ? 'Priority' : 'Normal'}</span>
                </div>
            `;
            
            item.addEventListener('click', () => this.selectTicket(ticket));
            this.queueList.appendChild(item);
        });
        
        // Update stats
        document.getElementById('currentQueueSize').textContent = tickets.length;
    }
    
    async callNext() {
        if (!this.session) return;
        
        try {
            this.setButtonLoading('next', true);
            
            const response = await fetch(`${CONFIG.API_BASE}/terminal/call-next`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    sessionId: this.session.id,
                    serviceId: this.selectedService
                })
            });
            
            if (!response.ok) {
                const error = await response.json();
                throw new Error(error.error || 'Failed to call next ticket');
            }
            
            const data = await response.json();
            this.currentTicket = data.ticket;
            this.updateTicketDisplay();
            this.startServiceTimer();
            
            this.addActivity('Called ticket', this.currentTicket.ticket_number);
            this.showNotification(`Called ticket ${this.currentTicket.ticket_number}`, 'success');
            
        } catch (error) {
            this.showNotification(error.message, 'error');
        } finally {
            this.setButtonLoading('next', false);
        }
    }
    
    async recall() {
        if (!this.session || !this.currentTicket) return;
        
        try {
            const response = await fetch(`${CONFIG.API_BASE}/terminal/recall`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    sessionId: this.session.id,
                    ticketId: this.currentTicket.id
                })
            });
            
            if (!response.ok) throw new Error('Failed to recall ticket');
            
            this.addActivity('Recalled', this.currentTicket.ticket_number);
            this.showNotification(`Recalled ticket ${this.currentTicket.ticket_number}`, 'success');
            
        } catch (error) {
            this.showNotification(error.message, 'error');
        }
    }
    
    async complete() {
        if (!this.session || !this.currentTicket) return;
        
        try {
            const response = await fetch(`${CONFIG.API_BASE}/terminal/complete`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    sessionId: this.session.id,
                    ticketId: this.currentTicket.id
                })
            });
            
            if (!response.ok) throw new Error('Failed to complete ticket');
            
            this.addActivity('Completed', this.currentTicket.ticket_number);
            this.showNotification(`Completed ticket ${this.currentTicket.ticket_number}`, 'success');
            
            this.currentTicket = null;
            this.updateTicketDisplay();
            this.loadQueue();
            
            // Update stats
            this.incrementTicketsServed();
            
        } catch (error) {
            this.showNotification(error.message, 'error');
        }
    }
    
    async noShow() {
        if (!this.session || !this.currentTicket) return;
        
        try {
            const response = await fetch(`${CONFIG.API_BASE}/terminal/no-show`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    sessionId: this.session.id,
                    ticketId: this.currentTicket.id
                })
            });
            
            if (!response.ok) throw new Error('Failed to mark no-show');
            
            this.addActivity('No show', this.currentTicket.ticket_number);
            this.showNotification(`Marked ${this.currentTicket.ticket_number} as no-show`, 'success');
            
            this.currentTicket = null;
            this.updateTicketDisplay();
            this.loadQueue();
            
        } catch (error) {
            this.showNotification(error.message, 'error');
        }
    }
    
    async park() {
        if (!this.session || !this.currentTicket) return;
        
        try {
            const response = await fetch(`${CONFIG.API_BASE}/terminal/park`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    sessionId: this.session.id,
                    ticketId: this.currentTicket.id
                })
            });
            
            if (!response.ok) throw new Error('Failed to park ticket');
            
            this.addActivity('Parked', this.currentTicket.ticket_number);
            this.showNotification(`Parked ticket ${this.currentTicket.ticket_number}`, 'success');
            
            this.currentTicket = null;
            this.updateTicketDisplay();
            
        } catch (error) {
            this.showNotification(error.message, 'error');
        }
    }
    
    async recycle() {
        if (!this.session || !this.currentTicket) return;
        
        try {
            const response = await fetch(`${CONFIG.API_BASE}/terminal/recycle`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    sessionId: this.session.id,
                    ticketId: this.currentTicket.id
                })
            });
            
            if (!response.ok) throw new Error('Failed to recycle ticket');
            
            this.addActivity('Recycled', this.currentTicket.ticket_number);
            this.showNotification(`Recycled ticket ${this.currentTicket.ticket_number}`, 'success');
            
            this.currentTicket = null;
            this.updateTicketDisplay();
            this.loadQueue();
            
        } catch (error) {
            this.showNotification(error.message, 'error');
        }
    }
    
    async transfer() {
        if (!this.session || !this.currentTicket) return;
        
        // For SOLO version, transfer is to service only (not counter/staff)
        const services = [
            { id: 1, name: 'General Service' },
            { id: 2, name: 'Account Services' },
            { id: 3, name: 'VIP Services' },
            { id: 4, name: 'Technical Support' }
        ];
        
        const currentService = this.currentTicket.service_id;
        const availableServices = services.filter(s => s.id !== currentService);
        
        // Simple selection (in production, use a proper modal)
        const serviceNames = availableServices.map(s => `${s.id}: ${s.name}`).join('\n');
        const selection = prompt(`Transfer to which service?\n\n${serviceNames}\n\nEnter service number:`);
        
        if (!selection) return;
        
        const targetServiceId = parseInt(selection);
        if (!availableServices.find(s => s.id === targetServiceId)) {
            this.showNotification('Invalid service selection', 'error');
            return;
        }
        
        try {
            const response = await fetch(`${CONFIG.API_BASE}/terminal/transfer`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    sessionId: this.session.id,
                    ticketId: this.currentTicket.id,
                    toServiceId: targetServiceId
                })
            });
            
            if (!response.ok) throw new Error('Failed to transfer ticket');
            
            const targetService = services.find(s => s.id === targetServiceId);
            this.addActivity('Transferred', `${this.currentTicket.ticket_number} to ${targetService.name}`);
            this.showNotification(`Transferred to ${targetService.name}`, 'success');
            
            this.currentTicket = null;
            this.updateTicketDisplay();
            this.loadQueue();
            
        } catch (error) {
            this.showNotification(error.message, 'error');
        }
    }
    
    async toggleCounter() {
        // Toggle between open/close counter
        const currentState = this.actionButtons.openClose.querySelector('.action-btn-text').textContent;
        const newState = currentState === 'OPEN' ? 'CLOSE' : 'OPEN';
        
        try {
            const response = await fetch(`${CONFIG.API_BASE}/terminal/toggle-counter`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    sessionId: this.session.id,
                    state: newState.toLowerCase()
                })
            });
            
            if (!response.ok) throw new Error('Failed to toggle counter');
            
            this.actionButtons.openClose.querySelector('.action-btn-text').textContent = newState;
            this.showNotification(`Counter ${newState.toLowerCase()}d`, 'success');
            
        } catch (error) {
            this.showNotification(error.message, 'error');
        }
    }
    
    updateTicketDisplay() {
        if (!this.currentTicket) {
            this.noTicket.style.display = 'flex';
            this.ticketDisplay.style.display = 'none';
            
            // Disable action buttons
            ['recall', 'end', 'noShow', 'recycle', 'park', 'transfer'].forEach(btn => {
                this.actionButtons[btn].disabled = true;
            });
            
            // Clear service timer
            if (this.serviceTimer) {
                clearInterval(this.serviceTimer);
                this.serviceTimer = null;
            }
        } else {
            this.noTicket.style.display = 'none';
            this.ticketDisplay.style.display = 'block';
            
            // Update ticket info
            document.getElementById('ticketNumber').textContent = this.currentTicket.ticket_number;
            document.getElementById('serviceName').textContent = this.getServiceName(this.currentTicket.service_id);
            
            const waitTime = Math.floor((new Date(this.currentTicket.called_at || Date.now()).getTime() - new Date(this.currentTicket.created_at).getTime()) / 1000);
            document.getElementById('waitTime').textContent = this.formatTime(waitTime);
            document.getElementById('queuePosition').textContent = '#1';
            document.getElementById('customerName').textContent = this.currentTicket.customer_name || 'Walk-in Customer';
            document.getElementById('customerPhone').textContent = this.currentTicket.customer_phone || 'No phone';
            
            // Enable action buttons
            ['recall', 'end', 'noShow', 'park', 'transfer'].forEach(btn => {
                this.actionButtons[btn].disabled = false;
            });
            
            // Enable recycle only if feature is enabled
            this.checkFeatureFlags();
        }
    }
    
    async checkFeatureFlags() {
        // Check which features are enabled
        try {
            const response = await fetch(`${CONFIG.API_BASE}/admin/settings`);
            if (response.ok) {
                const settings = await response.json();
                
                // Enable/disable buttons based on feature flags
                this.actionButtons.park.style.display = settings['feature.park_unpark'] === 'true' ? 'flex' : 'none';
                this.actionButtons.recycle.style.display = settings['feature.recycle'] === 'true' ? 'flex' : 'none';
            }
        } catch (error) {
            console.error('Failed to load feature flags:', error);
        }
    }
    
    handleServiceChange(e) {
        this.selectedService = parseInt(e.target.value);
        this.socket.emit('join-service', this.selectedService);
        this.loadQueue();
    }
    
    handlePriorityToggle(e) {
        document.querySelectorAll('.toggle-btn').forEach(btn => btn.classList.remove('active'));
        e.target.classList.add('active');
        this.selectedPriority = parseInt(e.target.dataset.priority);
        this.loadQueue();
    }
    
    switchPanel(e) {
        const tab = e.target.closest('.panel-tab');
        if (!tab) return;
        
        document.querySelectorAll('.panel-tab').forEach(t => t.classList.remove('active'));
        tab.classList.add('active');
        
        // Hide all panels
        document.querySelectorAll('.panel-section').forEach(p => p.style.display = 'none');
        
        // Show selected panel
        const panelId = tab.dataset.panel + 'Panel';
        const panel = document.getElementById(panelId);
        if (panel) panel.style.display = 'block';
    }
    
    // Socket.IO event handlers
    handleTicketCreated(data) {
        if (data.ticket.serviceId === this.selectedService) {
            this.loadQueue();
            this.addActivity('New ticket', data.ticket.number);
        }
    }
    
    handleTicketCalled(data) {
        if (data.ticket.serviceId === this.selectedService) {
            this.loadQueue();
        }
    }
    
    handleTicketCompleted(data) {
        if (data.ticketId === this.currentTicket?.id) {
            this.currentTicket = null;
            this.updateTicketDisplay();
        }
        this.loadQueue();
    }
    
    handleTicketParked(data) {
        this.loadQueue();
        this.addActivity('Ticket parked', data.ticket.number);
    }
    
    handleTicketRecycled(data) {
        this.loadQueue();
        this.addActivity('Ticket recycled', data.ticket.number);
    }
    
    handleTicketTransferred(data) {
        this.loadQueue();
        this.addActivity('Ticket transferred', `${data.ticket.number} to ${data.ticket.toServiceName}`);
    }
    
    handleQueueUpdated(data) {
        if (data.serviceId === this.selectedService) {
            this.loadQueue();
        }
    }
    
    handleCounterUpdated(data) {
        if (data.counterId === this.session?.counter.id) {
            // Update counter state if needed
        }
    }
    
    handleSystemAlert(data) {
        this.showNotification(data.message, data.type || 'info');
    }
    
    // Helper methods
    getServiceName(serviceId) {
        const services = {
            1: 'General Service',
            2: 'Account Services',
            3: 'VIP Services',
            4: 'Technical Support'
        };
        return services[serviceId] || 'Unknown Service';
    }
    
    formatTime(seconds) {
        const mins = Math.floor(seconds / 60);
        const secs = seconds % 60;
        return `${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
    }
    
    startServiceTimer() {
        let seconds = 0;
        if (this.serviceTimer) clearInterval(this.serviceTimer);
        
        this.serviceTimer = setInterval(() => {
            seconds++;
            document.getElementById('serviceTime').textContent = this.formatTime(seconds);
        }, 1000);
    }
    
    startSessionTimer() {
        let seconds = 0;
        this.sessionTimer = setInterval(() => {
            seconds++;
            const hours = Math.floor(seconds / 3600);
            const minutes = Math.floor((seconds % 3600) / 60);
            const secs = seconds % 60;
            
            document.getElementById('sessionTimer').textContent = 
                `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
        }, 1000);
    }
    
    addActivity(action, detail) {
        const activity = document.createElement('div');
        activity.className = 'activity-item animate-in';
        activity.innerHTML = `
            <div class="activity-icon">🎯</div>
            <div class="activity-content">
                <div class="activity-title">${action} - ${detail}</div>
                <div class="activity-time">Just now</div>
            </div>
        `;
        this.activityPanel.insertBefore(activity, this.activityPanel.firstChild);
        
        // Keep only last 10 activities
        while (this.activityPanel.children.length > 10) {
            this.activityPanel.removeChild(this.activityPanel.lastChild);
        }
    }
    
    async loadStats() {
        try {
            const response = await fetch(`${CONFIG.API_BASE}/admin/reports/daily`);
            if (response.ok) {
                const stats = await response.json();
                document.getElementById('ticketsServed').textContent = stats.ticketsServed || 0;
                document.getElementById('avgServiceTime').textContent = this.formatTime(stats.avgServiceTime || 0);
            }
        } catch (error) {
            console.error('Failed to load stats:', error);
        }
    }
    
    incrementTicketsServed() {
        const current = parseInt(document.getElementById('ticketsServed').textContent) || 0;
        document.getElementById('ticketsServed').textContent = current + 1;
    }
    
    setButtonLoading(buttonKey, loading) {
        const button = this.actionButtons[buttonKey];
        if (loading) {
            button.classList.add('loading');
        } else {
            button.classList.remove('loading');
        }
    }
    
    showNotification(message, type = 'success') {
        const notification = document.createElement('div');
        notification.className = `notification ${type}`;
        notification.innerHTML = `
            <span>${type === 'success' ? '✅' : '❌'}</span>
            <span>${message}</span>
        `;
        document.body.appendChild(notification);
        
        setTimeout(() => {
            notification.remove();
        }, 3000);
    }
    
    async checkExistingSession() {
        const savedSession = localStorage.getItem('flowmatic_session');
        if (savedSession) {
            this.session = JSON.parse(savedSession);
            
            // Verify session is still valid
            try {
                const response = await fetch(`${CONFIG.API_BASE}/terminal/session/${this.session.id}`);
                if (response.ok) {
                    this.initializeTerminal();
                } else {
                    localStorage.removeItem('flowmatic_session');
                }
            } catch (error) {
                localStorage.removeItem('flowmatic_session');
            }
        }
    }
    
    logout() {
        if (confirm('Are you sure you want to logout?')) {
            // Call logout endpoint
            if (this.session) {
                fetch(`${CONFIG.API_BASE}/terminal/logout`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ sessionId: this.session.id })
                });
            }
            
            localStorage.removeItem('flowmatic_session');
            if (this.socket) this.socket.disconnect();
            location.reload();
        }
    }
    
    selectTicket(ticket) {
        // For cherry-pick functionality (if enabled)
        console.log('Selected ticket:', ticket);
        // Implementation depends on feature flags
    }
}

// Initialize terminal when DOM is ready
document.addEventListener('DOMContentLoaded', () => {
    window.flowmaticTerminal = new FlowMaticTerminal();
});