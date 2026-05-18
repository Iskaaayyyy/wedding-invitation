const express = require("express");
const mysql = require("mysql2/promise");
const path = require("path");
const multer = require("multer");
const fs = require("fs");
const os = require("os");
const archiver = require("archiver");
const { google } = require("googleapis");

require("dotenv").config({ path: path.join(__dirname, ".env") });

const app = express();

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, "../frontend")));

const upload = multer({
  storage: multer.diskStorage({
    destination: function (req, file, cb) {
      cb(null, os.tmpdir());
    },
    filename: function (req, file, cb) {
      const safeName = Date.now() + "-" + file.originalname.replace(/[^a-zA-Z0-9.\-_]/g, "_");
      cb(null, safeName);
    },
  }),
  limits: {
    fileSize: 2 * 1024 * 1024 * 1024, // 2GB per file
    files: 50,
  },
  fileFilter: function (req, file, cb) {
    const isImage = file.mimetype.startsWith("image/");
    const isVideo = file.mimetype.startsWith("video/");

    if (!isImage && !isVideo) {
      return cb(new Error("Only photo and video files are allowed."));
    }

    cb(null, true);
  },
});

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

function getDriveClient() {
  if (!process.env.GOOGLE_CLIENT_EMAIL || !process.env.GOOGLE_PRIVATE_KEY || !process.env.GOOGLE_DRIVE_FOLDER_ID) {
    throw new Error("Google Drive credentials are not configured.");
  }

  const auth = new google.auth.JWT({
    email: process.env.GOOGLE_CLIENT_EMAIL,
    key: process.env.GOOGLE_PRIVATE_KEY.replace(/\\n/g, "\n"),
    scopes: ["https://www.googleapis.com/auth/drive"],
  });

  return google.drive({
    version: "v3",
    auth,
  });
}

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
        media_type VARCHAR(20) DEFAULT 'image',
        file_name VARCHAR(255),
        mime_type VARCHAR(100),
        status ENUM('Pending', 'Approved') DEFAULT 'Pending',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    await addColumnIfMissing("wedding_memories", "media_type", "VARCHAR(20) DEFAULT 'image'");
    await addColumnIfMissing("wedding_memories", "file_name", "VARCHAR(255)");
    await addColumnIfMissing("wedding_memories", "mime_type", "VARCHAR(100)");

    console.log("Database tables are ready.");
  } catch (error) {
    console.error("Database Initialization Error:", error.message);
  }
}

async function addColumnIfMissing(tableName, columnName, columnDefinition) {
  try {
    await pool.execute(`
      ALTER TABLE ${tableName}
      ADD COLUMN ${columnName} ${columnDefinition}
    `);
  } catch (error) {
    const message = error.message.toLowerCase();

    if (!message.includes("duplicate") && !message.includes("exists")) {
      console.error(`Column Update Error (${columnName}):`, error.message);
    }
  }
}

initializeDatabase();

app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "../frontend/index.html"));
});

app.get("/admin.html", (req, res) => {
  res.sendFile(path.join(__dirname, "../frontend/admin.html"));
});

app.get("/memories.html", (req, res) => {
  res.sendFile(path.join(__dirname, "../frontend/memories.html"));
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
        CONCAT('/api/memories/', id, '/media') AS image_url,
        media_type,
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
  upload.array("memoryPhotos", 50)(req, res, async function (error) {
    const uploadedTempFiles = req.files || [];

    try {
      if (error) {
        return res.status(400).json({
          success: false,
          message: error.message,
        });
      }

      const { guestName, memoryMessage } = req.body;

      if (!guestName || uploadedTempFiles.length === 0) {
        return res.status(400).json({
          success: false,
          message: "Your name and at least one photo or video are required.",
        });
      }

      const drive = getDriveClient();

      for (const file of uploadedTempFiles) {
        const mediaType = file.mimetype.startsWith("video/") ? "video" : "image";

        const driveUpload = await drive.files.create({
          requestBody: {
            name: file.originalname,
            parents: [process.env.GOOGLE_DRIVE_FOLDER_ID],
            mimeType: file.mimetype,
          },
          media: {
            mimeType: file.mimetype,
            body: fs.createReadStream(file.path),
          },
          fields: "id, name, mimeType, webViewLink",
        });

        const driveFileId = driveUpload.data.id;

        const driveViewLink = `https://drive.google.com/file/d/${driveFileId}/view`;

        await pool.execute(
          `INSERT INTO wedding_memories
          (guest_name, message, image_url, public_id, media_type, file_name, mime_type, status)
          VALUES (?, ?, ?, ?, ?, ?, ?, 'Pending')`,
          [
            guestName.trim(),
            memoryMessage || "",
            driveViewLink,
            driveFileId,
            mediaType,
            file.originalname,
            file.mimetype,
          ]
        );

        fs.unlink(file.path, function () {});
      }

      res.json({
        success: true,
        message: "Thank you! Your memories were uploaded and are waiting for approval.",
      });
    } catch (uploadError) {
      console.error("Google Drive Upload Error:", uploadError.message);

      for (const file of uploadedTempFiles) {
        fs.unlink(file.path, function () {});
      }

      res.status(500).json({
        success: false,
        message: "Unable to upload memories. Please try again.",
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
        CONCAT('/api/memories/', id, '/media') AS image_url,
        public_id,
        media_type,
        file_name,
        mime_type,
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
    const drive = getDriveClient();

    const [rows] = await pool.execute(
      "SELECT public_id FROM wedding_memories WHERE id = ?",
      [id]
    );

    if (rows.length > 0 && rows[0].public_id) {
      try {
        await drive.files.delete({
          fileId: rows[0].public_id,
        });
      } catch (driveError) {
        console.error("Google Drive Delete Warning:", driveError.message);
      }
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

app.get("/api/memories/:id/media", async (req, res) => {
  try {
    const { id } = req.params;
    const drive = getDriveClient();

    const [rows] = await pool.execute(
      `SELECT public_id, mime_type, file_name 
       FROM wedding_memories
       WHERE id = ?`,
      [id]
    );

    if (rows.length === 0) {
      return res.status(404).send("Memory not found.");
    }

    const file = rows[0];

    const driveResponse = await drive.files.get(
      {
        fileId: file.public_id,
        alt: "media",
      },
      {
        responseType: "stream",
      }
    );

    res.setHeader("Content-Type", file.mime_type || "application/octet-stream");
    driveResponse.data.pipe(res);
  } catch (error) {
    console.error("Media Stream Error:", error.message);
    res.status(500).send("Unable to load memory media.");
  }
});

function cleanFilename(value) {
  return String(value || "memory")
    .replace(/[^a-z0-9]/gi, "_")
    .toLowerCase();
}

async function appendDriveFileToZip(archive, drive, memory) {
  try {
    const driveResponse = await drive.files.get(
      {
        fileId: memory.public_id,
        alt: "media",
      },
      {
        responseType: "stream",
      }
    );

    const extension = memory.media_type === "video" ? "mp4" : "jpg";
    const filename = memory.file_name
      ? memory.file_name.replace(/[^a-zA-Z0-9.\-_]/g, "_")
      : `${cleanFilename(memory.guest_name)}_memory_${memory.id}.${extension}`;

    archive.append(driveResponse.data, { name: filename });
  } catch (error) {
    console.error("ZIP Append Error:", error.message);
  }
}

async function downloadMemoriesAsZip(rows, res, zipName) {
  const drive = getDriveClient();

  res.setHeader("Content-Type", "application/zip");
  res.setHeader("Content-Disposition", `attachment; filename="${zipName}"`);

  const archive = archiver("zip", {
    zlib: { level: 9 },
  });

  archive.on("error", function (error) {
    throw error;
  });

  archive.pipe(res);

  for (const memory of rows) {
    await appendDriveFileToZip(archive, drive, memory);
  }

  await archive.finalize();
}

app.get("/api/memories/:id/download", async (req, res) => {
  try {
    const { id } = req.params;
    const drive = getDriveClient();

    const [rows] = await pool.execute(
      `SELECT id, guest_name, public_id, media_type, file_name, mime_type
       FROM wedding_memories 
       WHERE id = ? AND status = 'Approved'`,
      [id]
    );

    if (rows.length === 0) {
      return res.status(404).send("Memory not found.");
    }

    const memory = rows[0];

    const driveResponse = await drive.files.get(
      {
        fileId: memory.public_id,
        alt: "media",
      },
      {
        responseType: "stream",
      }
    );

    const extension = memory.media_type === "video" ? "mp4" : "jpg";
    const filename = memory.file_name
      ? memory.file_name.replace(/[^a-zA-Z0-9.\-_]/g, "_")
      : `${cleanFilename(memory.guest_name)}_memory_${memory.id}.${extension}`;

    res.setHeader("Content-Type", memory.mime_type || "application/octet-stream");
    res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);

    driveResponse.data.pipe(res);
  } catch (error) {
    console.error("Download Memory Error:", error.message);
    res.status(500).send("Unable to download memory.");
  }
});

app.get("/api/memories/download/all", async (req, res) => {
  try {
    const [rows] = await pool.query(
      `SELECT id, guest_name, public_id, media_type, file_name, mime_type
       FROM wedding_memories
       WHERE status = 'Approved'
       ORDER BY created_at DESC`
    );

    if (rows.length === 0) {
      return res.status(404).send("No approved memories found.");
    }

    await downloadMemoriesAsZip(rows, res, "mark-pauline-all-memories.zip");
  } catch (error) {
    console.error("Download All Memories Error:", error.message);
    res.status(500).send("Unable to download all memories.");
  }
});

app.get("/api/memories/download/selected", async (req, res) => {
  try {
    const ids = String(req.query.ids || "")
      .split(",")
      .map(id => Number(id))
      .filter(id => Number.isInteger(id) && id > 0);

    if (ids.length === 0) {
      return res.status(400).send("No memories selected.");
    }

    const placeholders = ids.map(() => "?").join(",");

    const [rows] = await pool.execute(
      `SELECT id, guest_name, public_id, media_type, file_name, mime_type
       FROM wedding_memories
       WHERE status = 'Approved' AND id IN (${placeholders})
       ORDER BY created_at DESC`,
      ids
    );

    if (rows.length === 0) {
      return res.status(404).send("No approved selected memories found.");
    }

    await downloadMemoriesAsZip(rows, res, "mark-pauline-selected-memories.zip");
  } catch (error) {
    console.error("Download Selected Memories Error:", error.message);
    res.status(500).send("Unable to download selected memories.");
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