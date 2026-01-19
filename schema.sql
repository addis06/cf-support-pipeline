CREATE TABLE IF NOT EXISTS Complaints (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    customer_email TEXT,
    text TEXT,
    sentiment TEXT,
    normalized_key TEXT,
    answer_type TEXT,
    answered BOOLEAN,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS Solutions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    normalized_key TEXT,
    solution_text TEXT
);

