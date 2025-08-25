// ============================================
// FLOWMATIC PRINT MANAGER - QZ TRAY
// ============================================
// Client-side thermal printer management using QZ Tray
// Download QZ Tray from: https://qz.io/download/

class PrintManager {
    constructor() {
        this.config = {
            printerName: 'EPSON TM-T82III Receipt', // Your exact printer name
            paperWidth: 58, // mm (58mm or 80mm)
            encoding: 'UTF-8'
        };
        this.connected = false;
        this.settings = {};
        this.init();
    }

    async init() {
        // Check if QZ Tray library is loaded
        if (typeof qz === 'undefined') {
            console.error('❌ QZ Tray library not loaded. Make sure qz-tray.js is included in HTML');
            this.showStatus('error', 'QZ Tray not loaded - printing disabled');
            return false;
        }

        // Load settings from server (optional)
        await this.loadSettings();
        
        // Connect to QZ Tray
        return await this.connectToQZ();
    }

    async loadSettings() {
        try {
            const response = await fetch('/api/admin/settings');
            if (response.ok) {
                const settings = await response.json();
                this.settings = Array.isArray(settings) 
                    ? settings.reduce((obj, s) => ({ ...obj, [s.key]: s.value }), {})
                    : settings;
                
                // Update printer config from settings if available
                if (this.settings['printer.name']) {
                    this.config.printerName = this.settings['printer.name'];
                }
                if (this.settings['printer.width']) {
                    this.config.paperWidth = parseInt(this.settings['printer.width']);
                }
            }
        } catch (error) {
            console.warn('Could not load settings, using defaults:', error);
        }
    }

    async connectToQZ() {
        try {
            // Connect to QZ Tray if not already connected
            if (!qz.websocket.isActive()) {
                console.log('🔌 Connecting to QZ Tray...');
                await qz.websocket.connect();
                console.log('✅ Connected to QZ Tray');
            }
            
            // Find thermal printer
            const printers = await qz.printers.find();
            console.log('🖨️ Available printers:', printers);
            
            // Check if our printer exists
            if (printers.includes(this.config.printerName)) {
                this.connected = true;
                console.log('✅ Thermal printer found:', this.config.printerName);
                return true;
            } else {
                console.error('❌ Printer not found:', this.config.printerName);
                console.log('Available printers:', printers);
                this.showStatus('warning', 'Printer not found - check printer name');
                return false;
            }
        } catch (error) {
            console.error('❌ QZ Tray connection failed:', error);
            this.showStatus('error', 'QZ Tray connection failed - is it running?');
            return false;
        }
    }

    async printTicket(ticketData) {
        console.log('🖨️ Print request for ticket:', ticketData);
        
        // Ensure we're connected
        if (!this.connected) {
            const connected = await this.connectToQZ();
            if (!connected) {
                // Fallback to browser print
                if (confirm('QZ Tray connection failed. Use browser print instead?')) {
                    window.print();
                }
                return false;
            }
        }

        try {
            // Create printer config
            const config = qz.configs.create(this.config.printerName);
            
            // Format ticket with ESC/POS commands
            const data = this.formatTicketData(ticketData);
            
            // Send to printer
            await qz.print(config, data);
            
            console.log('✅ Ticket printed successfully');
            this.showStatus('success', 'Ticket printed successfully');
            return true;
            
        } catch (error) {
            console.error('❌ Print failed:', error);
            this.showStatus('error', `Print failed: ${error.message}`);
            
            // Offer fallback
            if (confirm('Printing failed. Use browser print instead?')) {
                window.print();
            }
            return false;
        }
    }

    formatTicketData(ticketData) {
        // ESC/POS commands for thermal printer
        const ESC = '\x1B';
        const GS = '\x1D';
        
        // Build ticket layout
        const commands = [
            // Initialize printer
            ESC + '@',
            
            // Center alignment
            ESC + 'a' + '\x01',
            
            // Double height/width for header
            ESC + '!' + '\x30',
            'FLOWMATIC QUEUE\n',
            
            // Normal text
            ESC + '!' + '\x00',
            '================================\n',
            
            // Extra large for ticket number
            ESC + '!' + '\x38',
            `${ticketData.number}\n`,
            
            // Normal text
            ESC + '!' + '\x00',
            '================================\n',
            
            // Left alignment for details
            ESC + 'a' + '\x00',
            `Service: ${ticketData.service}\n`,
            `Wait Time: ${ticketData.wait}\n`,
            `Queue Position: ${ticketData.position}\n`,
            `Time: ${ticketData.created}\n`,
            '================================\n',
            
            // Center alignment for footer
            ESC + 'a' + '\x01',
            'Please wait for your number\n',
            'Thank you!\n\n',
            
            // Feed and cut
            ESC + 'd' + '\x05',  // Feed 5 lines
            GS + 'V' + '\x00'    // Full cut
        ];
        
        return commands;
    }

    showStatus(type, message) {
        // Show status in UI if available
        if (window.app && window.app.showPrintStatus) {
            window.app.showPrintStatus(type, message);
        } else {
            // Fallback to console
            console.log(`[${type.toUpperCase()}] ${message}`);
        }
    }

    // Check if we're in production mode
    isProductionMode() {
        return this.settings['feature.production_mode'] === 'true';
    }

    // Get printer information
    getPrinterInfo() {
        return {
            connected: this.connected,
            printerName: this.config.printerName,
            paperWidth: this.config.paperWidth + 'mm',
            qzVersion: typeof qz !== 'undefined' ? qz.version : 'Not loaded'
        };
    }

    // Test print function
    async testPrint() {
        console.log('🧪 Running test print...');
        
        const testTicket = {
            number: 'TEST001',
            service: 'Test Service',
            wait: '0 minutes',
            position: '1',
            created: new Date().toLocaleTimeString()
        };
        
        return await this.printTicket(testTicket);
    }

    // List available printers
    async listPrinters() {
        try {
            if (!qz.websocket.isActive()) {
                await qz.websocket.connect();
            }
            const printers = await qz.printers.find();
            console.log('Available printers:', printers);
            return printers;
        } catch (error) {
            console.error('Failed to list printers:', error);
            return [];
        }
    }

    // Update printer name
    setPrinter(printerName) {
        this.config.printerName = printerName;
        this.connected = false; // Force reconnection
        console.log('Printer changed to:', printerName);
    }
}

// Initialize global print manager
console.log('🚀 Initializing FlowMatic Print Manager...');
window.printManager = new PrintManager();

// Auto-connect after page load
window.addEventListener('load', async () => {
    // Give QZ Tray library time to load
    setTimeout(async () => {
        if (window.printManager) {
            const info = window.printManager.getPrinterInfo();
            console.log('📋 Print Manager Info:', info);
        }
    }, 1000);
});

// Utility function for debugging
window.testPrint = async () => {
    if (window.printManager) {
        await window.printManager.testPrint();
    } else {
        console.error('Print manager not initialized');
    }
};

// List printers utility
window.listPrinters = async () => {
    if (window.printManager) {
        await window.printManager.listPrinters();
    } else {
        console.error('Print manager not initialized');
    }
};