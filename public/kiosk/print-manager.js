// ============================================
// FLOWMATIC PRINT MANAGER - HYBRID MODE
// ============================================
// Supports both QZ Tray and Browser printing
// Set USE_QZ_TRAY to false to use browser printing

class PrintManager {
    constructor() {
        // CONFIGURATION - Set to false to use browser printing
        this.USE_QZ_TRAY = false; // Changed to false for browser printing
        
        this.config = {
            printerName: 'TM-T82III', // Your printer name in CUPS
            paperWidth: 80, // mm (58mm or 80mm)
            encoding: 'UTF-8'
        };
        this.connected = false;
        this.settings = {};
        this.init();
    }

    async init() {
        // Load settings from server (optional)
        await this.loadSettings();
        
        if (this.USE_QZ_TRAY) {
            // Check if QZ Tray library is loaded
            if (typeof qz === 'undefined') {
                console.error('❌ QZ Tray library not loaded. Falling back to browser print.');
                this.USE_QZ_TRAY = false;
                this.showStatus('info', 'Using browser printing mode');
                return true;
            }
            // Connect to QZ Tray
            return await this.connectToQZ();
        } else {
            console.log('✅ Browser printing mode enabled');
            this.connected = true;
            this.showStatus('info', 'Using browser printing mode');
            return true;
        }
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
                // Check if QZ mode is set in settings
                if (this.settings['printer.use_qz'] !== undefined) {
                    this.USE_QZ_TRAY = this.settings['printer.use_qz'] === 'true';
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
            const printerFound = printers.some(p => 
                p.toLowerCase().includes(this.config.printerName.toLowerCase())
            );
            
            if (printerFound) {
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
            this.showStatus('error', 'QZ Tray connection failed - using browser print');
            this.USE_QZ_TRAY = false;
            this.connected = true;
            return true;
        }
    }

    async printTicket(ticketData) {
        console.log('🖨️ Print request for ticket:', ticketData);
        
        if (this.USE_QZ_TRAY) {
            return await this.printWithQZ(ticketData);
        } else {
            return await this.printWithBrowser(ticketData);
        }
    }

    async printWithQZ(ticketData) {
        // Ensure we're connected
        if (!this.connected) {
            const connected = await this.connectToQZ();
            if (!connected) {
                // Fallback to browser print
                return await this.printWithBrowser(ticketData);
            }
        }

        try {
            // Create printer config
            const config = qz.configs.create(this.config.printerName);
            
            // Format ticket with ESC/POS commands
            const data = this.formatTicketDataForQZ(ticketData);
            
            // Send to printer
            await qz.print(config, data);
            
            console.log('✅ Ticket printed successfully via QZ Tray');
            this.showStatus('success', 'Ticket printed successfully');
            return true;
            
        } catch (error) {
            console.error('❌ QZ Print failed:', error);
            this.showStatus('error', `Print failed: ${error.message}`);
            
            // Fallback to browser print
            return await this.printWithBrowser(ticketData);
        }
    }

    async printWithBrowser(ticketData) {
        try {
            // Create print content
            const printContent = this.formatTicketHTML(ticketData);
            
            // Create a hidden iframe for printing
            const printFrame = document.createElement('iframe');
            printFrame.style.position = 'absolute';
            printFrame.style.top = '-1000px';
            printFrame.style.left = '-1000px';
            document.body.appendChild(printFrame);
            
            // Write content to iframe
            const printDocument = printFrame.contentWindow.document;
            printDocument.open();
            printDocument.write(printContent);
            printDocument.close();
            
            // Wait for content to load
            await new Promise(resolve => setTimeout(resolve, 100));
            
            // Trigger print
            printFrame.contentWindow.focus();
            printFrame.contentWindow.print();
            
            // Clean up after a delay
            setTimeout(() => {
                document.body.removeChild(printFrame);
            }, 1000);
            
            console.log('✅ Ticket sent to browser print');
            this.showStatus('success', 'Ticket sent to printer');
            return true;
            
        } catch (error) {
            console.error('❌ Browser print failed:', error);
            this.showStatus('error', `Print failed: ${error.message}`);
            return false;
        }
    }

    formatTicketHTML(ticketData) {
        // Format ticket for browser printing
        return `
<!DOCTYPE html>
<html>
<head>
    <meta charset="UTF-8">
    <title>Ticket ${ticketData.number}</title>
    <style>
        @page {
            size: ${this.config.paperWidth}mm 297mm;
            margin: 0;
        }
        body {
            margin: 0;
            padding: 5mm;
            font-family: 'Courier New', monospace;
            font-size: 12pt;
            width: ${this.config.paperWidth - 10}mm;
        }
        .header {
            text-align: center;
            font-size: 16pt;
            font-weight: bold;
            margin-bottom: 5mm;
        }
        .ticket-number {
            text-align: center;
            font-size: 48pt;
            font-weight: bold;
            margin: 10mm 0;
            line-height: 1;
        }
        .divider {
            border-top: 2px dashed #000;
            margin: 5mm 0;
        }
        .info {
            margin: 3mm 0;
            font-size: 11pt;
        }
        .info-label {
            font-weight: bold;
        }
        .footer {
            text-align: center;
            margin-top: 10mm;
            font-size: 10pt;
        }
        @media print {
            body {
                width: ${this.config.paperWidth - 10}mm;
            }
        }
    </style>
</head>
<body>
    <div class="header">FLOWMATIC QUEUE</div>
    <div class="divider"></div>
    
    <div class="ticket-number">${ticketData.number}</div>
    
    <div class="divider"></div>
    
    <div class="info">
        <span class="info-label">Service:</span> ${ticketData.service}
    </div>
    <div class="info">
        <span class="info-label">Est. Wait:</span> ${ticketData.wait}
    </div>
    <div class="info">
        <span class="info-label">Position:</span> #${ticketData.position} in queue
    </div>
    <div class="info">
        <span class="info-label">Time:</span> ${ticketData.created}
    </div>
    
    <div class="divider"></div>
    
    <div class="footer">
        Please wait for your number<br>
        to be called<br><br>
        Thank you!
    </div>
</body>
</html>
        `;
    }

    formatTicketDataForQZ(ticketData) {
        // ESC/POS commands for thermal printer (QZ Tray)
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
            mode: this.USE_QZ_TRAY ? 'QZ Tray' : 'Browser Print',
            connected: this.connected,
            printerName: this.config.printerName,
            paperWidth: this.config.paperWidth + 'mm',
            qzVersion: (this.USE_QZ_TRAY && typeof qz !== 'undefined') ? qz.version : 'Not used'
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
        if (this.USE_QZ_TRAY) {
            try {
                if (typeof qz !== 'undefined' && !qz.websocket.isActive()) {
                    await qz.websocket.connect();
                }
                const printers = await qz.printers.find();
                console.log('Available printers (QZ):', printers);
                return printers;
            } catch (error) {
                console.error('Failed to list printers:', error);
                return [];
            }
        } else {
            console.log('Browser print mode - printer selection handled by browser');
            return ['Browser default printer'];
        }
    }

    // Update printer name
    setPrinter(printerName) {
        this.config.printerName = printerName;
        this.connected = false; // Force reconnection
        console.log('Printer changed to:', printerName);
    }

    // Toggle between QZ and Browser printing
    setPrintMode(useQZ) {
        this.USE_QZ_TRAY = useQZ;
        console.log('Print mode changed to:', useQZ ? 'QZ Tray' : 'Browser');
        this.init(); // Reinitialize
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

// Toggle print mode utility
window.setPrintMode = (useQZ) => {
    if (window.printManager) {
        window.printManager.setPrintMode(useQZ);
    } else {
        console.error('Print manager not initialized');
    }
};