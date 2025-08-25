-- Services (General, Account, VIP, Technical)
CREATE TABLE services (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    prefix TEXT NOT NULL, -- A, B, V, T
    description TEXT,
    range_start INTEGER DEFAULT 1,
    range_end INTEGER DEFAULT 999,
    current_number INTEGER DEFAULT 0,
    is_active BOOLEAN DEFAULT true,
    estimated_service_time INTEGER DEFAULT 300, -- seconds
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- Counters (serving positions)
CREATE TABLE counters (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL, -- "Counter 1", "Counter A"
    number INTEGER NOT NULL, -- Display number
    location TEXT, -- "Main Hall", "VIP Area"
    is_active BOOLEAN DEFAULT true,
    current_ticket_id INTEGER,
    current_agent_id INTEGER,
    state TEXT DEFAULT 'offline', -- offline, available, serving, break
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (current_ticket_id) REFERENCES tickets(id),
    FOREIGN KEY (current_agent_id) REFERENCES agents(id)
);

-- Agents (staff members)
CREATE TABLE agents (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT UNIQUE NOT NULL,
    name TEXT NOT NULL,
    email TEXT,
    role TEXT DEFAULT 'agent', -- agent, supervisor, admin
    is_active BOOLEAN DEFAULT true,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- Tickets (core entity)
CREATE TABLE tickets (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ticket_number TEXT NOT NULL, -- A001, B045, V003
    service_id INTEGER NOT NULL,
    state TEXT DEFAULT 'waiting', -- waiting, called, serving, completed, parked, recycled, no_show
    priority INTEGER DEFAULT 0, -- 0=normal, 1=priority, 2=vip
    customer_name TEXT,
    customer_phone TEXT,
    customer_email TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    called_at DATETIME,
    served_at DATETIME,
    completed_at DATETIME,
    estimated_wait INTEGER, -- seconds at creation
    actual_wait INTEGER, -- seconds from creation to served
    service_duration INTEGER, -- seconds from served to completed
    counter_id INTEGER,
    agent_id INTEGER,
    recall_count INTEGER DEFAULT 0,
    notes TEXT,
    FOREIGN KEY (service_id) REFERENCES services(id),
    FOREIGN KEY (counter_id) REFERENCES counters(id),
    FOREIGN KEY (agent_id) REFERENCES agents(id)
);

-- Agent-Service Assignments
CREATE TABLE agent_services (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    agent_id INTEGER NOT NULL,
    service_id INTEGER NOT NULL,
    priority INTEGER DEFAULT 1, -- 1=primary, 2=secondary
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (agent_id) REFERENCES agents(id),
    FOREIGN KEY (service_id) REFERENCES services(id),
    UNIQUE(agent_id, service_id)
);

-- Events (audit trail + real-time)
CREATE TABLE events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    event_type TEXT NOT NULL, -- TICKET_CREATED, TICKET_CALLED, etc.
    entity_type TEXT NOT NULL, -- ticket, counter, agent
    entity_id INTEGER NOT NULL,
    data JSON, -- event payload
    agent_id INTEGER,
    counter_id INTEGER,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (agent_id) REFERENCES agents(id),
    FOREIGN KEY (counter_id) REFERENCES counters(id)
);

-- Settings (feature flags + configuration)
CREATE TABLE settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    description TEXT,
    category TEXT DEFAULT 'general',
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- Sessions (agent login tracking)
CREATE TABLE sessions (
    id TEXT PRIMARY KEY, -- UUID
    agent_id INTEGER NOT NULL,
    counter_id INTEGER,
    login_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    logout_at DATETIME,
    is_active BOOLEAN DEFAULT true,
    FOREIGN KEY (agent_id) REFERENCES agents(id),
    FOREIGN KEY (counter_id) REFERENCES counters(id)
);

-- Indexes for Performance
CREATE INDEX idx_tickets_state ON tickets(state);
CREATE INDEX idx_tickets_service ON tickets(service_id);
CREATE INDEX idx_tickets_created ON tickets(created_at);
CREATE INDEX idx_events_type ON events(event_type);
CREATE INDEX idx_events_created ON events(created_at);

-- Default Data
INSERT INTO services (name, prefix, description, range_start, range_end) VALUES
('General Service', 'A', 'General inquiries and services', 1, 199),
('Account Services', 'B', 'Account opening, modifications', 200, 399),
('VIP Services', 'C', 'Premium customer services', 1, 99),
('Technical Support', 'D', 'Technical assistance and support', 1, 199);

INSERT INTO counters (name, number, location) VALUES
('Counter 1', 1, 'Main Hall'),
('Counter 2', 2, 'Main Hall'),
('VIP Counter', 3, 'VIP Area'),
('Technical Counter', 4, 'Technical Area');

INSERT INTO settings (key, value, description, category) VALUES
('feature.park_unpark', 'false', 'Enable park/unpark functionality', 'features'),
('feature.cherry_pick', 'false', 'Enable cherry pick (call any ticket)', 'features'),
('feature.recycle', 'false', 'Enable ticket recycling', 'features'),
('feature.multi_service', 'false', 'Enable multi-service priorities', 'features'),
('feature.voice_announcements', 'true', 'Enable voice announcements', 'features'),
('config.recycle_position', '3', 'Position to insert recycled tickets', 'config'),
('config.max_recall_count', '3', 'Maximum recall attempts', 'config'),
('config.auto_complete_timeout', '1800', 'Auto-complete serving tickets (seconds)', 'config'),
('system.name', 'FlowMatic-SOLO', 'System name', 'branding'),
('system.version', '2.0.0', 'System version', 'system');