class PrintManager {
    async printTicket(ticketData) {
        // FORCE PRODUCTION MODE - NO SETTINGS CHECK
        console.log('Production mode: Direct print');
        window.print();
    }
}

window.printManager = new PrintManager();