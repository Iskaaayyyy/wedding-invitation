CREATE DATABASE wedding_rsvp_db;

USE wedding_rsvp_db;

CREATE TABLE rsvp_responses (
    id INT AUTO_INCREMENT PRIMARY KEY,
    full_name VARCHAR(150) NOT NULL,
    attendance ENUM('Yes', 'No', 'Maybe') NOT NULL,
    guests INT DEFAULT 0,
    phone VARCHAR(30),
    message TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);