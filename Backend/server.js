const express = require("express");
const mysql = require("mysql2/promise");
const path = require("path");
const multer = require("multer");
const cloudinary = require("cloudinary").v2;
const axios = require("axios");
const archiver = require("archiver");

require("dotenv").config({ path: path.join(__dirname, ".env") });

const app = express();

cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 5 * 1024 * 1024,
  },
  fileFilter: function (req, file, cb) {
    if (!file.mimetype.startsWith("image/")) {
      return cb(new Error("Only image files are allowed."));
    }

    cb(null, true);
  },
});

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.use(express.static(path.join(__dirname, "../frontend")));

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

async function initializeDatabase() {
  try {
    await pool.execute(`
      CREATE TABLE IF NOT EXISTS rsvp_responses (
        id INT AUTO_INCREMENT PRIMARY KEY,
        full_name VARCHAR(150) NOT NULL,
        attendance ENUM('Yes', 'No') NOT NULL,
        guests INT DEFAULT 0,
        phone VARCHAR(30),
        message TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    await pool.execute(`
      CREATE TABLE IF NOT EXISTS wedding_memories (
        id INT AUTO_INCREMENT PRIMARY KEY,
        guest_name VARCHAR(150) NOT NULL,
        message TEXT,
        image_url TEXT NOT NULL,
        public_id VARCHAR(255) NOT NULL,
        status ENUM('Pending', 'Approved') DEFAULT 'Pending',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    console.log("Database tables are ready.");
  } catch (error) {
    console.error("Database Initialization Error:", error.message);
  }
}

initializeDatabase();

app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "../frontend/index.html"));
});

app.get("/admin.html", (req, res) => {
  res.sendFile(path.join(__dirname, "../frontend/admin.html"));
});

app.post("/api/rsvp", async (req, res) => {
  try {
    const { fullName, attendance, guests, phone, message } = req.body;

    if (!fullName || !attendance) {
      return res.status(400).json({
        success: false,
        message: "Full name and attendance are required.",
      });
    }

    const allowedAttendance = ["Yes", "No"];

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

app.put("/api/admin/rsvps/:id", checkAdminPassword, async (req, res) => {
  try {
    const { id } = req.params;
    const { attendance, phone, message } = req.body;

    const allowedAttendance = ["Yes", "No"];

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

app.get("/api/memories", async (req, res) => {
  try {
    const [rows] = await pool.query(
      `SELECT 
        id,
        guest_name,
        message,
        image_url,
        created_at
      FROM wedding_memories
      WHERE status = 'Approved'
      ORDER BY created_at DESC`
    );

    res.json({
      success: true,
      data: rows,
    });
  } catch (error) {
    console.error("Memory Fetch Error:", error.message);

    res.status(500).json({
      success: false,
      message: "Unable to load memories.",
    });
  }
});

app.post("/api/memories", function (req, res) {
  upload.single("memoryPhoto")(req, res, async function (error) {
    try {
      if (error) {
        return res.status(400).json({
          success: false,
          message: error.message,
        });
      }

      const { guestName, memoryMessage } = req.body;

      if (!guestName || !req.file) {
        return res.status(400).json({
          success: false,
          message: "Your name and photo are required.",
        });
      }

      const base64Image = `data:${req.file.mimetype};base64,${req.file.buffer.toString("base64")}`;

      const uploadResult = await cloudinary.uploader.upload(base64Image, {
        folder: "mark-pauline-wedding-memories",
        resource_type: "image",
      });

      await pool.execute(
        `INSERT INTO wedding_memories
        (guest_name, message, image_url, public_id, status)
        VALUES (?, ?, ?, ?, 'Pending')`,
        [
          guestName.trim(),
          memoryMessage || "",
          uploadResult.secure_url,
          uploadResult.public_id,
        ]
      );

      res.json({
        success: true,
        message: "Thank you! Your memory was uploaded and is waiting for approval.",
      });
    } catch (uploadError) {
      console.error("Memory Upload Error:", uploadError.message);

      res.status(500).json({
        success: false,
        message: "Unable to upload memory. Please try again.",
      });
    }
  });
});

app.get("/api/admin/memories", checkAdminPassword, async (req, res) => {
  try {
    const [rows] = await pool.query(
      `SELECT 
        id,
        guest_name,
        message,
        image_url,
        public_id,
        status,
        created_at
      FROM wedding_memories
      ORDER BY created_at DESC`
    );

    res.json({
      success: true,
      data: rows,
    });
  } catch (error) {
    console.error("Admin Memory Fetch Error:", error.message);

    res.status(500).json({
      success: false,
      message: "Unable to load uploaded memories.",
    });
  }
});

app.put("/api/admin/memories/:id/approve", checkAdminPassword, async (req, res) => {
  try {
    const { id } = req.params;

    await pool.execute(
      "UPDATE wedding_memories SET status = 'Approved' WHERE id = ?",
      [id]
    );

    res.json({
      success: true,
      message: "Memory approved successfully.",
    });
  } catch (error) {
    console.error("Approve Memory Error:", error.message);

    res.status(500).json({
      success: false,
      message: "Unable to approve memory.",
    });
  }
});

app.delete("/api/admin/memories/:id", checkAdminPassword, async (req, res) => {
  try {
    const { id } = req.params;

    const [rows] = await pool.execute(
      "SELECT public_id FROM wedding_memories WHERE id = ?",
      [id]
    );

    if (rows.length > 0 && rows[0].public_id) {
      await cloudinary.uploader.destroy(rows[0].public_id);
    }

    await pool.execute("DELETE FROM wedding_memories WHERE id = ?", [id]);

    res.json({
      success: true,
      message: "Memory deleted successfully.",
    });
  } catch (error) {
    console.error("Delete Memory Error:", error.message);

    res.status(500).json({
      success: false,
      message: "Unable to delete memory.",
    });
  }
});

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

app.get("/health", (req, res) => {
  res.send("Server is running.");
});

app.use((req, res) => {
  res.status(404).send("Page not found.");
});

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log(`Wedding invitation running at http://localhost:${PORT}`);
});