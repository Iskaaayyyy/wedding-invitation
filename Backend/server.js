const express = require("express");
const mysql = require("mysql2/promise");
const path = require("path");
require("dotenv").config({ path: path.join(__dirname, ".env") });

const app = express();

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Serve frontend files
app.use(express.static(path.join(__dirname, "../frontend")));

// MySQL / TiDB connection
const pool = mysql.createPool({
  host: process.env.MYSQLHOST || process.env.DB_HOST || "localhost",
  port: Number(process.env.MYSQLPORT || process.env.DB_PORT || 3306),
  user: process.env.MYSQLUSER || process.env.DB_USER || "root",
  password: process.env.MYSQLPASSWORD || process.env.DB_PASSWORD || "",
  database: process.env.MYSQLDATABASE || process.env.DB_NAME || "wedding_rsvp_db",
  waitForConnections: true,
  connectionLimit: 10,
  ssl:
    process.env.DB_SSL === "true"
      ? {
          minVersion: "TLSv1.2",
          rejectUnauthorized: true,
        }
      : undefined,
});

// Auto-create table if it does not exist
async function initializeDatabase() {
  try {
    await pool.execute(`
      CREATE TABLE IF NOT EXISTS rsvp_responses (
        id INT AUTO_INCREMENT PRIMARY KEY,
        full_name VARCHAR(150) NOT NULL,
        attendance ENUM('Yes', 'No', 'Maybe') NOT NULL,
        guests INT DEFAULT 0,
        phone VARCHAR(30),
        message TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    console.log("Database table is ready.");
  } catch (error) {
    console.error("Database Initialization Error:", error.message);
  }
}

initializeDatabase();

// Homepage
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "../frontend/index.html"));
});

// Admin page
app.get("/admin.html", (req, res) => {
  res.sendFile(path.join(__dirname, "../frontend/admin.html"));
});

// RSVP submission
app.post("/api/rsvp", async (req, res) => {
  try {
    const { fullName, attendance, guests, phone, message } = req.body;

    if (!fullName || !attendance) {
      return res.status(400).json({
        success: false,
        message: "Full name and attendance are required.",
      });
    }

    const allowedAttendance = ["Yes", "No", "Maybe"];

    if (!allowedAttendance.includes(attendance)) {
      return res.status(400).json({
        success: false,
        message: "Invalid attendance response.",
      });
    }

    await pool.execute(
      `INSERT INTO rsvp_responses 
      (full_name, attendance, guests, phone, message) 
      VALUES (?, ?, ?, ?, ?)`,
      [
        fullName.trim(),
        attendance,
        Number(guests) || 0,
        phone || "",
        message || "",
      ]
    );

    res.json({
      success: true,
      message: "Thank you! Your RSVP has been submitted.",
    });
  } catch (error) {
    console.error("RSVP Error:", error.message);

    res.status(500).json({
      success: false,
      message: "Something went wrong. Please try again.",
    });
  }
});

// Admin password middleware
function checkAdminPassword(req, res, next) {
  const adminPassword = req.headers["x-admin-password"];

  if (!process.env.ADMIN_PASSWORD) {
    return res.status(500).json({
      success: false,
      message: "Admin password is not set.",
    });
  }

  if (adminPassword !== process.env.ADMIN_PASSWORD) {
    return res.status(401).json({
      success: false,
      message: "Unauthorized access.",
    });
  }

  next();
}

// Get all RSVP records
app.get("/api/admin/rsvps", checkAdminPassword, async (req, res) => {
  try {
    const [rows] = await pool.query(
      `SELECT 
        id,
        full_name,
        attendance,
        guests,
        phone,
        message,
        created_at
      FROM rsvp_responses
      ORDER BY created_at DESC`
    );

    res.json({
      success: true,
      data: rows,
    });
  } catch (error) {
    console.error("Admin RSVP Fetch Error:", error.message);

    res.status(500).json({
      success: false,
      message: "Unable to load RSVP records.",
    });
  }
});

// Update RSVP record
app.put("/api/admin/rsvps/:id", checkAdminPassword, async (req, res) => {
  try {
    const { id } = req.params;
    const { attendance, phone, message } = req.body;

    const allowedAttendance = ["Yes", "No", "Maybe"];

    if (!allowedAttendance.includes(attendance)) {
      return res.status(400).json({
        success: false,
        message: "Invalid attendance status.",
      });
    }

    await pool.execute(
      `UPDATE rsvp_responses
       SET attendance = ?, phone = ?, message = ?
       WHERE id = ?`,
      [attendance, phone || "", message || "", id]
    );

    res.json({
      success: true,
      message: "Guest record updated successfully.",
    });
  } catch (error) {
    console.error("Admin RSVP Update Error:", error.message);

    res.status(500).json({
      success: false,
      message: "Unable to update guest record.",
    });
  }
});

// Delete RSVP record
app.delete("/api/admin/rsvps/:id", checkAdminPassword, async (req, res) => {
  try {
    const { id } = req.params;

    await pool.execute("DELETE FROM rsvp_responses WHERE id = ?", [id]);

    res.json({
      success: true,
      message: "Guest record deleted successfully.",
    });
  } catch (error) {
    console.error("Admin RSVP Delete Error:", error.message);

    res.status(500).json({
      success: false,
      message: "Unable to delete guest record.",
    });
  }
});

// Test database connection
app.get("/test-db", async (req, res) => {
  try {
    const [rows] = await pool.query("SELECT 1 AS database_connected");

    res.json({
      success: true,
      message: "Database connected successfully.",
      result: rows,
    });
  } catch (error) {
    console.error("Database Test Error:", error.message);

    res.status(500).json({
      success: false,
      message: error.message,
    });
  }
});

// Health check
app.get("/health", (req, res) => {
  res.send("Server is running.");
});

// 404 fallback
app.use((req, res) => {
  res.status(404).send("Page not found.");
});

// Start server
const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log(`Wedding invitation running at http://localhost:${PORT}`);
});