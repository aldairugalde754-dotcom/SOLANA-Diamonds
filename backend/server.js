import express from 'express';
import cors from 'cors';
import mysql from 'mysql2/promise';
import bcrypt from 'bcrypt';
import jwt from 'jsonwebtoken';
import dotenv from 'dotenv';
import bs58 from 'bs58';
import multer from 'multer';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { uploadImageToIPFS, uploadMetadataToIPFS } from './pinataService.js';
import { createUmi } from '@metaplex-foundation/umi-bundle-defaults';
import { dasApi } from '@metaplex-foundation/digital-asset-standard-api';
import { mplBubblegum, transfer as bubblegumTransfer, getAssetWithProof } from '@metaplex-foundation/mpl-bubblegum';
import { keypairIdentity, publicKey as umiPublicKey } from '@metaplex-foundation/umi';
import { fromWeb3JsKeypair } from '@metaplex-foundation/umi-web3js-adapters';

// Imports de Solana nativos (Estos sí soportan ESM perfectamente)
import { Connection, PublicKey, Transaction, Keypair, sendAndConfirmTransaction, TransactionInstruction } from '@solana/web3.js';
import anchor from '@coral-xyz/anchor';

// Importación de tu IDL (Apuntando a tu carpeta idl/)
import rawIdl from './idl/certchain.json' with { type: 'json' };
import { getBidValidationError } from './auctionBidRules.js';

// 🚀 EL PUENTE DEFINITIVO PARA RECONCILIAR COMMONJS CON ESM
import { createRequire } from 'module';
const requireLegacy = createRequire(import.meta.url);

// Cargamos las librerías conflictivas pasándole SOLO el nombre del paquete
const { 
  createAllocTreeIx, 
  SPL_ACCOUNT_COMPRESSION_PROGRAM_ID, 
  SPL_NOOP_PROGRAM_ID 
} = requireLegacy('@solana/spl-account-compression');

const { 
  MPL_BUBBLEGUM_PROGRAM_ID 
} = requireLegacy('@metaplex-foundation/mpl-bubblegum');

const BUBBLEGUM_PROGRAM_ID = new PublicKey(MPL_BUBBLEGUM_PROGRAM_ID);

dotenv.config();
const app = express();
const PORT = process.env.PORT || 4000;

// DAS RPC endpoint for server-side verification (falls back to env or Helius Devnet)
const DAS_RPC_URL = process.env.DAS_RPC_URL || process.env.REACT_APP_DAS_RPC || process.env.VITE_DAS_RPC || 'https://devnet.helius-rpc.com/?api-key=568c37da-25db-4b18-b55c-143df09820c1';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Ensure uploads directory exists
const uploadsDir = path.join(__dirname, 'uploads');
fs.mkdirSync(uploadsDir, { recursive: true });

// Dirección de tu Smart Contract
const programIdStr = process.env.PROGRAM_ID || rawIdl.address || "HPHKMbccxYmwR6Q1AdNSnNPvh6f5BtTCAn1Mvc993E7P";
if (!programIdStr) {
  throw new Error("No se pudo obtener el programId de Solana (define process.env.PROGRAM_ID o idl.address).");
}
const PROGRAM_ID = new PublicKey(programIdStr);

// 🛠️ Sanitización de IDL para evitar errores de codificador Borsh de Anchor ('publicKey' vs 'pubkey')
const cleanIdl = JSON.parse(
  JSON.stringify(rawIdl).replaceAll('"publicKey"', '"pubkey"')
);
cleanIdl.address = PROGRAM_ID.toBase58();

// Normalizar dinámicamente nombres de cuentas relacionados con el "registro".
// Algunos IDLs usan "registro" y otros "registroGlobal"; esto asegura que
// todas las instrucciones esperen el mismo alias y que podamos derivar PDAs
// usando la misma semilla.
(function normalizeRegistroNames() {
  const instrs = cleanIdl.instructions || [];
  let canonical = null;

  // Preferir registroGlobal si está presente en cualquier instrucción
  for (const ins of instrs) {
    for (const acc of ins.accounts || []) {
      if (/^registroGlobal$/i.test(acc.name)) { canonical = 'registroGlobal'; break; }
    }
    if (canonical) break;
  }
  // Si no existe registroGlobal, buscar registro
  if (!canonical) {
    for (const ins of instrs) {
      for (const acc of ins.accounts || []) {
        if (/^registro$/i.test(acc.name)) { canonical = 'registro'; break; }
      }
      if (canonical) break;
    }
  }

  // Si se determinó un nombre canónico, reemplazar variantes en todas las instrucciones
  if (canonical) {
    for (const ins of instrs) {
      for (const acc of ins.accounts || []) {
        if (/registro/i.test(acc.name) && acc.name !== canonical) {
          acc.name = canonical;
        }
      }
    }
  }
})();

// Helper para obtener lista de nombres de cuentas de una instrucción del IDL
function getInstructionAccountNames(idl, instructionName) {
  const instr = (idl.instructions || []).find(i => i.name === instructionName);
  return (instr && instr.accounts) ? instr.accounts.map(a => a.name) : [];
}

// Creador manual de la instrucción de inicialización de Merkle Tree de Bubblegum
function createCreateTreeInstructionManual({
  treeConfig,
  merkleTree,
  payer,
  treeCreator,
  logWrapper,
  compressionProgram,
  systemProgram,
}, { maxDepth, maxBufferSize, public: isPublic }) {
  const discriminator = Buffer.from([165, 83, 136, 142, 89, 202, 47, 220]);
  const data = Buffer.alloc(discriminator.length + 4 + 4 + 2);
  discriminator.copy(data, 0);
  data.writeUInt32LE(maxDepth, 8);
  data.writeUInt32LE(maxBufferSize, 12);
  
  // Option<bool>: Some(isPublic) -> 1 seguido por (isPublic ? 1 : 0)
  data.writeUInt8(1, 16);
  data.writeUInt8(isPublic ? 1 : 0, 17);

  const keys = [
    { pubkey: treeConfig, isSigner: false, isWritable: true },
    { pubkey: merkleTree, isSigner: false, isWritable: true },
    { pubkey: payer, isSigner: true, isWritable: true },
    { pubkey: treeCreator, isSigner: true, isWritable: false },
    { pubkey: logWrapper, isSigner: false, isWritable: false },
    { pubkey: compressionProgram, isSigner: false, isWritable: false },
    { pubkey: systemProgram, isSigner: false, isWritable: false },
  ];

  return new TransactionInstruction({
    keys,
    programId: BUBBLEGUM_PROGRAM_ID,
    data,
  });
}

// Helper para formato de enum TipoEmisor en Anchor
export const TIPO_EMISOR_MAP = {
  joyeria: { joyeria: {} },
  galeria: { galeria: {} },
  casaSubastas: { casaSubastas: {} },
  relojeriaCertificada: { relojeriaCertificada: {} },
  bodegaCertificada: { bodegaCertificada: {} },
  otro: { otro: {} }
};

export function parseTipoEmisor(tipo) {
  if (!tipo) return { otro: {} };
  if (typeof tipo === 'object') return tipo;
  const key = String(tipo).trim().toLowerCase();
  switch (key) {
    case 'joyeria': case 'joyería': return { joyeria: {} };
    case 'galeria': case 'galería': return { galeria: {} };
    case 'casasubastas': case 'casa_subastas': return { casaSubastas: {} };
    case 'relojeria': case 'relojeriacertificada': return { relojeriaCertificada: {} };
    case 'bodega': case 'bodegacertificada': return { bodegaCertificada: {} };
    default: return { otro: {} };
  }
}

export function parseCategoryId(categoria) {
  if (typeof categoria === 'number' && !isNaN(categoria)) return categoria;
  if (!categoria) return 1;
  const parsed = parseInt(categoria, 10);
  if (!isNaN(parsed)) return parsed;
  const key = String(categoria).trim().toLowerCase();
  switch (key) {
    case 'relojeria': case 'relojería': return 1;
    case 'joyeria': case 'joyería': return 2;
    case 'arte': case 'galeria': case 'galería': return 3;
    case 'moda': return 4;
    case 'vinos': case 'bodega': return 5;
    default: return 1;
  }
}

// MIDDLEWARES
app.use(express.json());

// Permitir CORS universal para que cualquier wallet (Solflare, Phantom), extensión o RPC lea los metadatos e imágenes
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Requested-With');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

// Servir carpetas de imágenes de manera pública con cabeceras CORS libres
app.use('/uploads', express.static(uploadsDir, {
  setHeaders: (res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
  }
}));

// Configuración de Multer para guardar imágenes de los certificados
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadsDir),
  filename: (req, file, cb) => cb(null, `${Date.now()}-${file.originalname}`)
});
const upload = multer({ storage });

// Helper para descargar imágenes externas y alojarlas localmente en /uploads (evita bloqueos CORS y hotlinking)
async function ensureLocalImage(imageUrl, host) {
  if (!imageUrl || typeof imageUrl !== 'string' || !imageUrl.trim()) {
    return `${host}/uploads/default.png`;
  }
  const cleanUrl = imageUrl.trim();

  // Si ya está alojada localmente en /uploads, la dejamos como está
  if (cleanUrl.includes('/uploads/')) {
    return cleanUrl;
  }

  // Si es una URL externa (http/https), la descargamos localmente para alojarla de forma segura
  if (/^https?:\/\//i.test(cleanUrl)) {
    try {
      console.log('Descargando imagen externa localmente:', cleanUrl);
      const response = await fetch(cleanUrl, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
        }
      });
      if (response.ok) {
        const contentType = response.headers.get('content-type') || '';
        let ext = '.png';
        if (contentType.includes('image/jpeg')) ext = '.jpg';
        else if (contentType.includes('image/webp')) ext = '.webp';
        else if (contentType.includes('image/gif')) ext = '.gif';
        else if (contentType.includes('image/svg')) ext = '.svg';
        else {
          const match = cleanUrl.match(/\.(png|jpg|jpeg|webp|gif|svg)(\?|$)/i);
          if (match) ext = '.' + match[1].toLowerCase();
        }

        const filename = `downloaded-${Date.now()}-${Math.floor(Math.random() * 10000)}${ext}`;
        const filePath = path.join(uploadsDir, filename);
        const buffer = Buffer.from(await response.arrayBuffer());
        await fs.promises.writeFile(filePath, buffer);
        console.log('Imagen descargada exitosamente en:', filename);
        return `${host}/uploads/${filename}`;
      }
    } catch (err) {
      console.warn('No se pudo descargar la imagen externa, usando URL original:', err.message);
    }
  }

  return cleanUrl;
}

// CONFIGURACIÓN DE LA BASE DE DATOS
// CONFIGURACIÓN DE LA BASE DE DATOS
const DB_HOST = process.env.DB_HOST || 'mysql-3b2d7573-aldairugalde754-3d62.j.aivencloud.com';
const DB_USER = process.env.DB_USER || process.env.DB_USERNAME || 'avnadmin';
const DB_PASSWORD = process.env.DB_PASSWORD || process.env.DB_PASS || '';
const DB_NAME = process.env.DB_NAME || 'defaultdb';
const DB_PORT = Number(process.env.DB_PORT || 11107);

// Configuración dinámica de SSL (requerido para Aiven Cloud)
const DB_SSL = (process.env.DB_SSL === 'true' || (DB_HOST && !['localhost', '127.0.0.1', '::1'].includes(DB_HOST)))
  ? { rejectUnauthorized: false }
  : undefined;

async function ensureDatabaseExists() {
  // En Aiven 'defaultdb' ya viene creada por defecto y el usuario 'avnadmin' 
  // no tiene permisos para consultar la base de datos del sistema 'mysql'.
  if (DB_HOST.includes('aivencloud.com')) {
    return; // Omitir en Aiven para evitar errores de permisos
  }

  try {
    const connection = await mysql.createConnection({
      host: DB_HOST,
      user: DB_USER,
      password: DB_PASSWORD,
      port: DB_PORT,
      database: 'mysql',
      ssl: DB_SSL
    });

    await connection.execute(`CREATE DATABASE IF NOT EXISTS \`${DB_NAME}\``);
    console.log(`Base de datos asegurada: ${DB_NAME}`);
    await connection.end();
  } catch (err) {
    console.warn('No se pudo verificar la existencia de la BD (omitido si la BD ya existe):', err.message);
  }
}

const db = mysql.createPool({
  host: DB_HOST,
  user: DB_USER,
  password: DB_PASSWORD,
  database: DB_NAME,
  port: DB_PORT,
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0,
  connectTimeout: 20000,
  ssl: DB_SSL
});

// Log DB connection info for debugging
console.log(`DB host=${DB_HOST} user=${DB_USER} database=${DB_NAME}`);

// Ruta raíz básica
app.get('/', (req, res) => {
  res.json({ message: 'CertChain API corriendo correctamente' });
});

// ==========================================
// RUTA DE REGISTRO DE USUARIOS
// ==========================================
app.post('/api/auth/register', async (req, res) => {
  console.log("=== DATOS RECIBIDOS EN EL BACKEND ===");
  const { email, password, role, company_name, wallet_address, walletAddress } = req.body;
  const finalWallet = wallet_address || walletAddress;
  const dbRole = role || 'buyer';

  try {
    const [existingEmail] = await db.execute('SELECT * FROM users WHERE email = ?', [email]);
    if (existingEmail.length > 0) {
      return res.status(400).json({ error: 'El correo electrónico ya está registrado' });
    }

    if (finalWallet && finalWallet.trim() !== '') {
      const [existingWallet] = await db.execute('SELECT * FROM users WHERE wallet_address = ?', [finalWallet.trim()]);
      if (existingWallet.length > 0) {
        return res.status(400).json({ error: 'Esta Wallet de Solana ya está vinculada a otra cuenta' });
      }
    }

    const formattedCompany = (company_name && String(company_name).trim() !== '') ? String(company_name).trim() : null;
    
    if (dbRole === 'company' && formattedCompany) {
      const [existingCompany] = await db.execute('SELECT * FROM users WHERE company_name = ?', [formattedCompany]);
      if (existingCompany.length > 0) {
        return res.status(400).json({ error: 'El nombre de esta empresa ya está registrado por otra organización' });
      }
    }

    const hashedPassword = await bcrypt.hash(password, 10);
    const formattedWallet = (finalWallet && String(finalWallet).trim() !== '') ? String(finalWallet).trim() : null;

    const [result] = await db.execute(
      'INSERT INTO users (email, password_hash, role, company_name, wallet_address) VALUES (?, ?, ?, ?, ?)',
      [email, hashedPassword, dbRole, formattedCompany, formattedWallet]
    );

    const userId = result.insertId;
    const userPayload = { id: userId, email, role: dbRole, company_name: formattedCompany, wallet_address: formattedWallet };
    const token = jwt.sign(userPayload, process.env.JWT_SECRET || 'secret_key', { expiresIn: '24h' });

    res.json({ token, user: userPayload });
  } catch (error) {
    console.error('Error crítico en el proceso de registro:', error);
    res.status(500).json({ error: 'Error interno al registrar en la base de datos' });
  }
});

// ==========================================
// RUTA DE LOGIN
// ==========================================
app.post('/api/auth/login', async (req, res) => {
  const { email, password } = req.body || {};
  if (!email || !password) {
    return res.status(400).json({ error: 'El correo electrónico y la contraseña son requeridos' });
  }

  try {
    const [users] = await db.execute('SELECT * FROM users WHERE email = ?', [email]);
    if (users.length === 0) return res.status(400).json({ error: 'Credenciales inválidas' });

    const user = users[0];
    if (!user.password_hash) {
      return res.status(400).json({ error: 'Credenciales inválidas' });
    }

    const validPassword = await bcrypt.compare(password, user.password_hash);
    if (!validPassword) return res.status(400).json({ error: 'Credenciales inválidas' });

    const userPayload = { id: user.id, email: user.email, role: user.role, company_name: user.company_name, wallet_address: user.wallet_address };
    const token = jwt.sign(userPayload, process.env.JWT_SECRET || 'secret_key', { expiresIn: '24h' });

    res.json({ token, user: userPayload });
  } catch (error) {
    console.error('Error en /api/auth/login:', error);
    res.status(500).json({ error: 'Error en el servidor', details: error.message });
  }
});

app.get('/api/auth/me', async (req, res) => {
  const authHeader = req.headers.authorization || '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;

  if (!token) {
    return res.status(401).json({ error: 'Token no proporcionado' });
  }

  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET || 'secret_key');
    const userId = decoded?.id;

    if (!userId) {
      return res.status(401).json({ error: 'Token inválido' });
    }

    const [rows] = await db.execute('SELECT id, email, role, company_name, wallet_address FROM users WHERE id = ?', [userId]);
    if (!rows || rows.length === 0) {
      return res.status(404).json({ error: 'Usuario no encontrado' });
    }

    const user = rows[0];
    return res.json({
      id: user.id,
      email: user.email,
      role: user.role,
      company_name: user.company_name,
      wallet_address: user.wallet_address,
    });
  } catch (error) {
    console.error('GET /api/auth/me error', error);
    return res.status(401).json({ error: 'Token inválido o expirado' });
  }
});

app.post('/api/auth/verify-company-wallet', async (req, res) => {
  const authHeader = req.headers.authorization || '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
  const { wallet_address } = req.body || {};

  if (!token) {
    return res.status(401).json({ error: 'Token no proporcionado' });
  }

  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET || 'secret_key');
    const userId = decoded?.id;

    if (!userId) {
      return res.status(401).json({ error: 'Token inválido' });
    }

    const [rows] = await db.execute('SELECT id, role, company_name, wallet_address FROM users WHERE id = ?', [userId]);
    if (!rows || rows.length === 0) {
      return res.status(404).json({ error: 'Usuario no encontrado' });
    }

    const user = rows[0];
    if (user.role !== 'company') {
      return res.status(403).json({ error: 'La validación de wallet solo aplica para cuentas de empresa' });
    }

    const registeredWallet = String(user.wallet_address || '').trim();
    const connectedWallet = String(wallet_address || '').trim();

    if (!registeredWallet) {
      return res.status(400).json({ error: 'Esta cuenta de empresa no tiene wallet registrada' });
    }

    if (!connectedWallet) {
      return res.status(400).json({ error: 'Se requiere la wallet conectada para validar la sesión' });
    }

    const isMatch = registeredWallet.toLowerCase() === connectedWallet.toLowerCase();
    if (!isMatch) {
      return res.status(403).json({
        error: 'La wallet conectada no coincide con la wallet registrada para esta cuenta.',
        registered_wallet: registeredWallet,
        connected_wallet: connectedWallet,
      });
    }

    return res.json({
      verified: true,
      company_name: user.company_name,
      registered_wallet: registeredWallet,
      connected_wallet: connectedWallet,
    });
  } catch (error) {
    console.error('POST /api/auth/verify-company-wallet error', error);
    return res.status(401).json({ error: 'Token inválido o expirado' });
  }
});

// ==========================================
// 🛠️ RUTA ADMINISTRATIVA: INITIALIZE MERKLE TREE
// ==========================================
app.post('/api/admin/setup-tree', async (req, res) => {
  console.log("=== INICIALIZANDO NUEVO MERKLE TREE EN DEVNET ===");
  try {
    const connection = new Connection("https://api.devnet.solana.com", "confirmed");

    if (!process.env.COMPANY_PRIVATE_KEY) {
      return res.status(500).json({ error: "Falta la variable de entorno COMPANY_PRIVATE_KEY" });
    }

    const companySecretKey = bs58.decode(process.env.COMPANY_PRIVATE_KEY);
    const companyKeypair = Keypair.fromSecretKey(companySecretKey);

    const merkleTreeKeypair = Keypair.generate();
    const merkleTreePubKey = merkleTreeKeypair.publicKey;

    const maxDepth = 14;
    const maxBufferSize = 64;

    const allocTreeIx = await createAllocTreeIx(
      connection,
      merkleTreePubKey,
      companyKeypair.publicKey,
      { maxDepth, maxBufferSize },
      0
    );

    const [treeConfigPda] = PublicKey.findProgramAddressSync(
      [merkleTreePubKey.toBuffer()],
      BUBBLEGUM_PROGRAM_ID
    );

    const SYSTEM_PROGRAM_ID = PublicKey.default;

    const isPublicTree = req.body.public !== undefined ? Boolean(req.body.public) : true;

    const createTreeIx = createCreateTreeInstructionManual(
      {
        treeConfig: treeConfigPda,
        merkleTree: merkleTreePubKey,
        payer: companyKeypair.publicKey,
        treeCreator: companyKeypair.publicKey,
        logWrapper: SPL_NOOP_PROGRAM_ID,
        compressionProgram: SPL_ACCOUNT_COMPRESSION_PROGRAM_ID,
        systemProgram: SYSTEM_PROGRAM_ID,
      },
      { maxDepth, maxBufferSize, public: isPublicTree }
    );

    const tx = new Transaction().add(allocTreeIx, createTreeIx);
    
    console.log("Enviando transaccion a Devnet...");
    const txSignature = await sendAndConfirmTransaction(
      connection, 
      tx, 
      [companyKeypair, merkleTreeKeypair], 
      { commitment: "confirmed" }
    );

    return res.json({
      success: true,
      merkleTreeAddress: merkleTreePubKey.toBase58(),
      isPublic: isPublicTree,
      txSignature
    });

  } catch (error) {
    console.error("Error al inicializar el Merkle Tree:", error);
    return res.status(500).json({ error: error.message });
  }
});

/**
 * Helper para validar la autenticidad de una transacción de emisión de cNFT en la blockchain de Solana.
 */
async function verifyTransactionOnChain(signature, expectedEmisor, expectedPropietario) {
  try {
    const rpcUrl = process.env.SOLANA_RPC_URL || "https://api.devnet.solana.com";
    const connection = new Connection(rpcUrl, "confirmed");
    
    const tx = await connection.getParsedTransaction(signature, {
      commitment: 'confirmed',
      maxSupportedTransactionVersion: 0
    });

    if (!tx) {
      return { valid: false, error: "La transacción no existe en Solana Devnet o aún no ha sido confirmada." };
    }

    if (tx.meta?.err) {
      return { valid: false, error: `La transacción fue registrada pero falló on-chain: ${JSON.stringify(tx.meta.err)}` };
    }

    const programIds = tx.transaction.message.instructions.map(ix => ix.programId.toBase58());
    const isBubblegumTx = programIds.includes(BUBBLEGUM_PROGRAM_ID.toBase58());

    if (!isBubblegumTx) {
      return { valid: false, error: "La transacción enviada no invocó al programa Metaplex Bubblegum." };
    }

    const accountKeys = tx.transaction.message.accountKeys.map(k => k.pubkey.toBase58());
    if (expectedEmisor && !accountKeys.includes(expectedEmisor)) {
      return { valid: false, error: "La wallet del emisor especificada no fue firmante ni participante de la transacción." };
    }

    return { valid: true };
  } catch (err) {
    console.error("Error durante la verificación de transacción en servidor:", err);
    return { valid: false, error: `Fallo durante la verificación RPC: ${err.message}` };
  }
}

// ==========================================
// ==========================================
// ENDPOINTS PARA SUBIR/CONSULTAR METADATOS E IMÁGENES
// ==========================================

// 1. ENDPOINT PARA CREAR REGISTRO PREVIO, SUBIR IMAGEN A PINATA Y GENERAR METADATOS JSON IPFS
app.post('/api/certificates/prepare', upload.single('image'), async (req, res) => {
  try {
    const {
      product_name,
      category,
      serial_number,
      manufacturing_year,
      origin_country,
      description,
      image_url,
      market_value,
      edition,
      material,
      acabado,
      garantia,
      peso,
      attributes
    } = req.body;

    console.log('POST /api/certificates/prepare - body:', req.body);
    console.log('POST /api/certificates/prepare - req.file:', req.file ? req.file.filename : null);

    const host = req.protocol + '://' + req.get('host');
    let localImagePath = null;
    let imageUrl = null;

    if (image_url && typeof image_url === 'string' && image_url.trim() !== '') {
      imageUrl = await ensureLocalImage(image_url.trim(), host);
      if (imageUrl.includes('/uploads/')) {
        try {
          const fname = path.basename(new URL(imageUrl, host).pathname);
          localImagePath = path.join(uploadsDir, fname);
        } catch (e) {
          localImagePath = null;
        }
      }
    } else if (req.file) {
      const filename = encodeURIComponent(req.file.filename);
      imageUrl = `${host}/uploads/${filename}`;
      localImagePath = req.file.path;
    } else {
      imageUrl = `${host}/uploads/default.png`;
      localImagePath = path.join(uploadsDir, 'default.png');
    }

    // Intentar subida de imagen a Pinata IPFS
    let ipfsImageUrl = null;
    if (localImagePath && fs.existsSync(localImagePath)) {
      const originalName = req.file ? req.file.originalname : `cert-image-${Date.now()}.png`;
      ipfsImageUrl = await uploadImageToIPFS(localImagePath, originalName);
    }

    // Preferir URL de Pinata IPFS si la subida fue exitosa, o fallback a URL HTTP del servidor
    const finalImageUrl = ipfsImageUrl || imageUrl;

    const [result] = await db.execute(
      `INSERT INTO certificates 
        (product_name, category, serial_number, manufacturing_year, origin_country, description, image_url, market_value, edition, material, acabado, garantia, peso, attributes, ipfs_image_url) 
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        product_name || null,
        category || null,
        serial_number || null,
        manufacturing_year || null,
        origin_country || null,
        description || null,
        finalImageUrl,
        market_value || null,
        edition || null,
        material || null,
        acabado || null,
        garantia || null,
        peso || null,
        typeof attributes === 'object' ? JSON.stringify(attributes) : (attributes || null),
        ipfsImageUrl || null
      ]
    );

    const certId = result.insertId;

    // Construir estructura de metadatos JSON compatible con Metaplex V1 y Pinata
    const attributesList = [];
    if (category) attributesList.push({ trait_type: "Categoría", value: String(category) });
    if (serial_number) attributesList.push({ trait_type: "Número de Serie", value: String(serial_number) });
    if (manufacturing_year) attributesList.push({ trait_type: "Año de Fabricación", value: String(manufacturing_year) });
    if (origin_country) attributesList.push({ trait_type: "País de Origen", value: String(origin_country) });
    if (market_value) attributesList.push({ trait_type: "Valor Estimado (USD)", value: String(market_value) });
    if (edition) attributesList.push({ trait_type: "Edición / Tiraje", value: String(edition) });
    if (material) attributesList.push({ trait_type: "Material Principal", value: String(material) });
    if (acabado) attributesList.push({ trait_type: "Acabado", value: String(acabado) });
    if (garantia) attributesList.push({ trait_type: "Garantía", value: String(garantia) });
    if (peso) attributesList.push({ trait_type: "Peso", value: String(peso) });

    if (attributes) {
      try {
        const customAttrs = typeof attributes === 'string' ? JSON.parse(attributes) : attributes;
        if (Array.isArray(customAttrs)) {
          customAttrs.forEach(attr => {
            if (attr && attr.trait_type && attr.value !== undefined) {
              if (!attributesList.some(a => a.trait_type === attr.trait_type)) {
                attributesList.push(attr);
              }
            }
          });
        }
      } catch (e) {
        console.warn('Error parseando custom attributes:', e);
      }
    }

    const metadataJson = {
      name: product_name || "Certificado de Autenticidad",
      symbol: "CERT",
      description: description || "Certificado digital inmutable de autenticidad emitido en CertChain.",
      seller_fee_basis_points: 0,
      image: finalImageUrl,
      external_url: "https://certchain.app",
      attributes: attributesList,
      properties: {
        files: [
          { uri: finalImageUrl, type: "image/png" }
        ],
        category: "image"
      }
    };

    // Subir metadatos JSON a Pinata IPFS
    const ipfsMetadataUrl = await uploadMetadataToIPFS(metadataJson, certId);
    if (ipfsMetadataUrl) {
      await db.execute('UPDATE certificates SET ipfs_metadata_url = ? WHERE id = ?', [ipfsMetadataUrl, certId]).catch(() => {});
    }

    const serverMetadataUri = `${host}/api/certificates/metadata/${certId}`;
    const primaryMetadataUri = ipfsMetadataUrl || serverMetadataUri;

    console.log(`Certificado ${certId} preparado exitosamente: primaryMetadataUri=${primaryMetadataUri}, ipfsImage=${ipfsImageUrl}`);

    res.json({
      certId,
      metadataUri: primaryMetadataUri,
      ipfsMetadataUri: ipfsMetadataUrl || null,
      serverMetadataUri,
      imageUrl: finalImageUrl
    });
  } catch (error) {
    console.error('Error en /api/certificates/prepare:', error);
    res.status(500).json({ error: error.message });
  }
});

// 2. ENDPOINT QUE DEVUELVE EL JSON QUE LEERÁ SOLFLARE Y HELIUS (DAS API)
app.get('/api/certificates/metadata/:id', async (req, res) => {
  try {
    console.log('GET /api/certificates/metadata/', req.params.id);
    const reqHost = req.protocol + '://' + req.get('host');
    const [rows] = await db.execute('SELECT * FROM certificates WHERE id = ?', [req.params.id]);
    
    // Si la ID no existe en MySQL (p.ej. NFTs minteados en pruebas anteriores), responder con JSON fallback para evitar 404 en Solflare
    if (!rows.length) {
      console.warn(`Certificado ID ${req.params.id} no encontrado en DB, retornando fallback JSON`);
      return res.json({
        name: "Certificado CertChain",
        symbol: "CERT",
        description: "Certificado de Autenticidad CertChain",
        seller_fee_basis_points: 0,
        image: `${reqHost}/uploads/default.png`,
        external_url: "https://certchain.app",
        attributes: [
          { trait_type: "Categoría", value: "Autenticidad" },
          { trait_type: "Estado", value: "Registrado" }
        ],
        properties: {
          files: [{ uri: `${reqHost}/uploads/default.png`, type: "image/png" }],
          category: "image",
          creators: []
        }
      });
    }

    const cert = rows[0];
    let imageUri = cert.image_url || '/uploads/default.png';

    // Si la imagen es una URL externa que aún no está alojada localmente, se descarga al vuelo
    if (/^https?:\/\//i.test(imageUri) && !imageUri.includes('/uploads/')) {
      const localUrl = await ensureLocalImage(imageUri, reqHost);
      if (localUrl !== imageUri) {
        imageUri = localUrl;
        db.execute('UPDATE certificates SET image_url = ? WHERE id = ?', [imageUri, cert.id]).catch(() => {});
      }
    }

    if (!/^https?:\/\//i.test(imageUri)) {
      if (imageUri.startsWith('/')) imageUri = `${reqHost}${imageUri}`;
      else imageUri = `${reqHost}/${imageUri.replace(/^\/+/, '')}`;
    } else {
      // Dynamic rewrite for localhost/127.0.0.1/LAN IPs to current requesting host
      imageUri = imageUri.replace(/^https?:\/\/(localhost|127\.0\.0\.1|192\.168\.\d+\.\d+)(:\d+)?/i, reqHost);
    }

    let fileType = 'image/png';
    try {
      const ext = path.extname(new URL(imageUri).pathname).toLowerCase();
      if (ext === '.jpg' || ext === '.jpeg') fileType = 'image/jpeg';
      else if (ext === '.gif') fileType = 'image/gif';
      else if (ext === '.webp') fileType = 'image/webp';
      else if (ext === '.svg') fileType = 'image/svg+xml';
    } catch (e) {
      // fallback
    }

    // Convertir la imagen local en Data URI base64 para que las extensiones de cartera (Solflare) la muestren directo sin depender de proxies CDN de IP privada
    let finalImage = imageUri;
    try {
      if (imageUri.includes('/uploads/')) {
        const filename = path.basename(new URL(imageUri, reqHost).pathname);
        const filePath = path.join(uploadsDir, filename);
        if (fs.existsSync(filePath)) {
          const fileBuf = await fs.promises.readFile(filePath);
          finalImage = `data:${fileType};base64,${fileBuf.toString('base64')}`;
        }
      }
    } catch (e) {
      console.warn('Fallback a URL HTTP en imagen:', e.message);
    }

    console.log('Serving metadata imageUri:', imageUri);

    const attributes = [];
    if (cert.category) attributes.push({ trait_type: "Categoría", value: String(cert.category) });
    if (cert.serial_number) attributes.push({ trait_type: "Número de Serie", value: String(cert.serial_number) });
    if (cert.manufacturing_year) attributes.push({ trait_type: "Año de Fabricación", value: String(cert.manufacturing_year) });
    if (cert.origin_country) attributes.push({ trait_type: "País de Origen", value: String(cert.origin_country) });
    if (cert.market_value) attributes.push({ trait_type: "Valor Estimado (USD)", value: String(cert.market_value) });
    if (cert.edition) attributes.push({ trait_type: "Edición / Tiraje", value: String(cert.edition) });
    if (cert.material) attributes.push({ trait_type: "Material Principal", value: String(cert.material) });
    if (cert.acabado) attributes.push({ trait_type: "Acabado", value: String(cert.acabado) });
    if (cert.garantia) attributes.push({ trait_type: "Garantía", value: String(cert.garantia) });
    if (cert.peso) attributes.push({ trait_type: "Peso", value: String(cert.peso) });

    if (cert.attributes) {
      try {
        const customAttrs = typeof cert.attributes === 'string' ? JSON.parse(cert.attributes) : cert.attributes;
        if (Array.isArray(customAttrs)) {
          customAttrs.forEach(attr => {
            if (attr && attr.trait_type && attr.value !== undefined) {
              if (!attributes.some(a => a.trait_type === attr.trait_type)) {
                attributes.push(attr);
              }
            }
          });
        }
      } catch (e) {
        console.warn('Error parsing custom attributes:', e);
      }
    }

    const metaplexJson = {
      name: cert.product_name || "Certificado de Autenticidad",
      symbol: "CERT",
      description: cert.description || "Certificado digital inmutable de autenticidad emitido en CertChain.",
      image: cert.ipfs_image_url || finalImage,
      external_url: "https://certchain.app",
      attributes,
      properties: {
        files: [
          { uri: cert.ipfs_image_url || finalImage, type: fileType }
        ],
        category: "image"
      }
    };

    res.json(metaplexJson);
  } catch (error) {
    console.error('Error en metadata endpoint:', error);
    res.status(500).json({ error: error.message });
  }
});

// 3. ACTUALIZAR CON EL HASH DE BLOCKCHAIN UNA VEZ MINTEADO
app.put('/api/certificates/confirm/:id', async (req, res) => {
  try {
    // Coerce undefined => null to avoid MySQL bind parameter errors
    const blockchain_tx = req.body.blockchain_tx === undefined ? null : req.body.blockchain_tx;
    const asset_id = req.body.asset_id === undefined ? null : req.body.asset_id;
    const owner_wallet = req.body.owner_wallet === undefined ? null : req.body.owner_wallet;

    await db.execute(
      'UPDATE certificates SET blockchain_tx = ?, asset_id = ?, owner_wallet = ? WHERE id = ?',
      [blockchain_tx, asset_id, owner_wallet, req.params.id]
    );
    res.json({ success: true });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: error.message });
  }
});

// Obtener certificados por owner_wallet (para el dashboard de la empresa)
app.get('/api/certificates/owner/:wallet', async (req, res) => {
  try {
    const wallet = req.params.wallet;
    const [rows] = await db.execute('SELECT * FROM certificates WHERE owner_wallet = ? ORDER BY id DESC', [wallet]);
    res.json(rows);
  } catch (err) {
    console.error('GET /api/certificates/owner/:wallet error', err);
    res.status(500).json({ error: err.message });
  }
});

// Verificar si una wallet emisora está registrada como empresa en CertChain
app.get('/api/companies/verify-wallet/:walletAddress', async (req, res) => {
  try {
    const wallet = String(req.params.walletAddress || '').trim();
    if (!wallet) return res.status(400).json({ error: 'Se requiere walletAddress' });

    const normalizedWallet = wallet.toLowerCase();

    const [rows] = await db.execute(
      'SELECT id, company_name, wallet_address, role, created_at FROM users WHERE LOWER(wallet_address) = ? LIMIT 1',
      [normalizedWallet]
    );

    if (!rows || rows.length === 0) {
      return res.status(404).json({ verified: false });
    }

    const company = rows[0];
    if (!company.company_name) {
      return res.status(404).json({ verified: false });
    }

    return res.json({
      verified: true,
      company_name: company.company_name,
      wallet_address: company.wallet_address,
      role: company.role,
      created_at: company.created_at,
    });
  } catch (err) {
    console.error('GET /api/companies/verify-wallet error', err);
    return res.status(500).json({ error: err.message });
  }
});

// ==========================================
// RUTA PARA EMISIÓN DEL CERTIFICADO (GUARDADO MYSQL CON VERIFICACIÓN ON-CHAIN)
// ==========================================
app.post('/api/certificates/create', async (req, res) => {
  try {
    const { certId, owner_wallet, blockchain_tx, asset_id } = req.body;

    if (!certId) return res.status(400).json({ error: 'Falta certId en el cuerpo de la petición' });

    await db.execute(
      `UPDATE certificates SET owner_wallet = ?, blockchain_tx = ?, asset_id = ? WHERE id = ?`,
      [owner_wallet || null, blockchain_tx || null, asset_id || null, certId]
    );

    res.json({ success: true, message: 'Certificado actualizado en BD' });
  } catch (error) {
    console.error('Error en /api/certificates/create:', error);
    res.status(500).json({ error: error.message });
  }
});

// --- ENDPOINT TEMPORAL: actualizar campos de metadata (para pruebas) ---
// Permite actualizar `image_url`, `product_name`, `description`, `category`, `serial_number`
app.patch('/api/certificates/:id', async (req, res) => {
  try {
    const allowed = ['image_url', 'product_name', 'description', 'category', 'serial_number'];
    const updates = [];
    const params = [];
    for (const key of allowed) {
      if (Object.prototype.hasOwnProperty.call(req.body, key)) {
        updates.push(`${key} = ?`);
        params.push(req.body[key]);
      }
    }
    if (!updates.length) return res.status(400).json({ error: 'No hay campos válidos para actualizar' });
    params.push(req.params.id);
    const sql = `UPDATE certificates SET ${updates.join(', ')} WHERE id = ?`;
    await db.execute(sql, params);
    return res.json({ success: true });
  } catch (err) {
    console.error('PATCH /api/certificates/:id error', err);
    return res.status(500).json({ error: err.message });
  }
});

// Registrar transferencia de certificado
app.post('/api/certificates/transfer', async (req, res) => {
  try {
    const { asset_id, previous_owner, new_owner, transfer_type, tx_hash } = req.body;
    if (!asset_id || !new_owner) {
      return res.status(400).json({ error: 'asset_id y new_owner son requeridos' });
    }

    try {
      await db.execute(
        'INSERT INTO certificate_transfers (asset_id, previous_owner, new_owner, transfer_type, tx_hash) VALUES (?, ?, ?, ?, ?)',
        [asset_id, previous_owner || 'Desconocido', new_owner, transfer_type || 'transfer', tx_hash || null]
      );
    } catch (e) {
      console.warn('Advertencia: No se pudo insertar certificate_transfers:', e.message);
    }

    await db.execute('UPDATE certificates SET owner_wallet = ? WHERE asset_id = ? OR id = ?', [new_owner, asset_id, asset_id]);

    res.json({ success: true, message: 'Transferencia registrada exitosamente' });
  } catch (err) {
    console.error('POST /api/certificates/transfer error:', err);
    res.status(500).json({ error: err.message });
  }
});

// Obtener historial completo de trazabilidad (Cadena de Custodia)
app.get('/api/certificates/history/:assetId', async (req, res) => {
  const { assetId } = req.params;
  try {
    // Asegurar tabla certificate_transfers al vuelo
    try {
      await db.execute(`
        CREATE TABLE IF NOT EXISTS certificate_transfers (
          id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
          asset_id VARCHAR(255) NOT NULL,
          previous_owner VARCHAR(128) NOT NULL,
          new_owner VARCHAR(128) NOT NULL,
          transfer_type VARCHAR(50) DEFAULT 'transfer',
          tx_hash VARCHAR(128),
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          KEY idx_cert_transfers_asset (asset_id),
          KEY idx_cert_transfers_new_owner (new_owner)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
      `);
    } catch (e) {
      console.warn('Could not ensure certificate_transfers table in history endpoint:', e.message);
    }

    // 1. Datos del certificado
    let cert = null;
    try {
      const [certs] = await db.execute('SELECT * FROM certificates WHERE asset_id = ? OR id = ?', [assetId, assetId]);
      cert = certs && certs.length > 0 ? certs[0] : null;
    } catch (e) {
      console.warn('Error fetching cert in history endpoint:', e.message);
    }

    // 2. Transferencias directas registradas
    let transfers = [];
    try {
      const [rows] = await db.execute('SELECT * FROM certificate_transfers WHERE asset_id = ? ORDER BY created_at ASC', [assetId]);
      transfers = Array.isArray(rows) ? rows : [];
    } catch (e) {
      console.warn('Error fetching transfers in history endpoint:', e.message);
    }

    // 3. Ventas en marketplace
    let mSales = [];
    try {
      const [rows] = await db.execute('SELECT * FROM marketplace_sales WHERE asset_id = ? ORDER BY created_at ASC', [assetId]);
      mSales = Array.isArray(rows) ? rows : [];
    } catch (e) {
      console.warn('Error fetching mSales in history endpoint:', e.message);
    }

    // 4. Ventas en subastas
    let aSales = [];
    try {
      const [rows] = await db.execute('SELECT * FROM auction_sales WHERE asset_id = ? ORDER BY created_at ASC', [assetId]);
      aSales = Array.isArray(rows) ? rows : [];
    } catch (e) {
      console.warn('Error fetching aSales in history endpoint:', e.message);
    }

    const history = [];

    // Evento de emisión inicial (Mint)
    const emisorWallet = cert?.company_wallet || cert?.user_wallet || cert?.owner_wallet || null;
    if (cert) {
      history.push({
        type: 'mint',
        title: cert.company_name ? `Certificado emitido por ${cert.company_name}` : 'Certificado emitido',
        from: cert.company_name || 'Emisor CertChain',
        to: emisorWallet,
        tx_hash: cert.blockchain_tx || cert.tx_hash || null,
        created_at: cert.created_at
      });
    }

    const txHashesSeen = new Set();
    if (cert?.blockchain_tx) txHashesSeen.add(cert.blockchain_tx);

    const allEvents = [];

    for (const t of transfers) {
      if (t.tx_hash && txHashesSeen.has(t.tx_hash)) continue;
      if (t.tx_hash) txHashesSeen.add(t.tx_hash);
      allEvents.push({
        type: t.transfer_type || 'transfer',
        title: t.transfer_type === 'marketplace_sale' ? 'Venta en Marketplace' : (t.transfer_type === 'auction_sale' ? 'Reclamación de Subasta' : 'Transferencia Directa'),
        from: t.previous_owner,
        to: t.new_owner,
        tx_hash: t.tx_hash,
        created_at: t.created_at
      });
    }

    for (const m of mSales) {
      if (m.tx_hash && txHashesSeen.has(m.tx_hash)) continue;
      if (m.tx_hash) txHashesSeen.add(m.tx_hash);
      allEvents.push({
        type: 'marketplace_sale',
        title: 'Venta en Marketplace',
        from: m.seller_wallet,
        to: m.buyer_wallet,
        price_usd: m.price_usd,
        tx_hash: m.tx_hash,
        created_at: m.created_at
      });
    }

    for (const a of aSales) {
      if (a.tx_hash && txHashesSeen.has(a.tx_hash)) continue;
      if (a.tx_hash) txHashesSeen.add(a.tx_hash);
      allEvents.push({
        type: 'auction_sale',
        title: 'Reclamación de Subasta',
        from: a.seller_wallet,
        to: a.buyer_wallet,
        price_usd: a.price_usd,
        tx_hash: a.tx_hash,
        created_at: a.created_at
      });
    }

    // Si la propiedad cambió y no hay eventos registrados explícitos, inferir la transferencia
    if (cert && cert.owner_wallet && emisorWallet && cert.owner_wallet !== emisorWallet && allEvents.length === 0) {
      allEvents.push({
        type: 'transfer',
        title: 'Transferencia de Custodia',
        from: emisorWallet,
        to: cert.owner_wallet,
        tx_hash: cert.blockchain_tx || null,
        created_at: cert.created_at
      });
    }

    allEvents.sort((a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime());

    res.json({
      asset_id: assetId,
      certificate: cert,
      history: [...history, ...allEvents]
    });
  } catch (err) {
    console.error('GET /api/certificates/history error:', err);
    res.json({ asset_id: assetId, history: [] });
  }
});


// ==========================================
// MARKETPLACE Y TABLAS BD: auto-creación y endpoints
// ==========================================
async function ensureDatabaseTables() {
  try {
    // await ensureDatabaseExists(); <--- Comentado para evitar el timeout
    await db.execute(`
      CREATE TABLE IF NOT EXISTS users (
        id INT AUTO_INCREMENT PRIMARY KEY,
        email VARCHAR(255) UNIQUE NOT NULL,
        password_hash VARCHAR(255) NOT NULL,
        role VARCHAR(50) DEFAULT 'buyer',
        company_name VARCHAR(255),
        wallet_address VARCHAR(255),
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
    `);

    await db.execute(`
      CREATE TABLE IF NOT EXISTS certificates (
        id INT AUTO_INCREMENT PRIMARY KEY,
        product_name VARCHAR(255),
        category VARCHAR(100),
        serial_number VARCHAR(100),
        manufacturing_year VARCHAR(50),
        origin_country VARCHAR(100),
        description TEXT,
        image_url TEXT,
        market_value VARCHAR(100),
        edition VARCHAR(100),
        material VARCHAR(100),
        acabado VARCHAR(100),
        garantia VARCHAR(100),
        peso VARCHAR(100),
        attributes JSON,
        owner_wallet VARCHAR(255),
        blockchain_tx TEXT,
        asset_id VARCHAR(255),
        ipfs_image_url TEXT,
        ipfs_metadata_url TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
    `);

    // Migraciones seguras para agregar columnas si la tabla ya existía anteriormente
    try { await db.execute(`ALTER TABLE certificates ADD COLUMN ipfs_image_url TEXT`); } catch (e) {}
    try { await db.execute(`ALTER TABLE certificates ADD COLUMN ipfs_metadata_url TEXT`); } catch (e) {}

    await db.execute(`
      CREATE TABLE IF NOT EXISTS marketplace_listings (
        id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
        asset_id VARCHAR(255) NOT NULL,
        seller_wallet VARCHAR(128) NOT NULL,
        price_usd DECIMAL(12,2) NOT NULL,
        description TEXT,
        title VARCHAR(255),
        image TEXT,
        category VARCHAR(100),
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        UNIQUE KEY ux_asset_id (asset_id)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
    `);

    await db.execute(`
      CREATE TABLE IF NOT EXISTS marketplace_sales (
        id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
        asset_id VARCHAR(255) NOT NULL,
        seller_wallet VARCHAR(128),
        buyer_wallet VARCHAR(128) NOT NULL,
        price_usd DECIMAL(12,2) NOT NULL,
        tx_hash VARCHAR(255),
        sold_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
    `);

    await db.execute(`
      CREATE TABLE IF NOT EXISTS auction_listings (
        id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
        asset_id VARCHAR(255) NOT NULL,
        seller_wallet VARCHAR(128) NOT NULL,
        starting_price DECIMAL(12,2) NOT NULL,
        current_bid DECIMAL(12,2) DEFAULT 0,
        current_bidder_wallet VARCHAR(128),
        reserve_price DECIMAL(12,2) DEFAULT 0,
        end_time DATETIME NOT NULL,
        status VARCHAR(32) DEFAULT 'live',
        description TEXT,
        title VARCHAR(255),
        image TEXT,
        category VARCHAR(100),
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        UNIQUE KEY ux_auction_asset_id (asset_id)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
    `);

    await db.execute(`
      CREATE TABLE IF NOT EXISTS auction_bids (
        id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
        auction_id BIGINT UNSIGNED NOT NULL,
        asset_id VARCHAR(255) NOT NULL,
        bidder_wallet VARCHAR(128) NOT NULL,
        bid_amount DECIMAL(12,2) NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        UNIQUE KEY ux_auction_bid_unique (auction_id, asset_id, bidder_wallet, bid_amount),
        KEY idx_auction_asset_wallet (auction_id, asset_id, bidder_wallet, created_at),
        KEY idx_auction_asset_amount (auction_id, asset_id, bid_amount)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
    `);

    await db.execute(`
      CREATE TABLE IF NOT EXISTS auction_bid_audit (
        id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
        auction_id BIGINT UNSIGNED NOT NULL,
        asset_id VARCHAR(255) NOT NULL,
        bidder_wallet VARCHAR(128) NOT NULL,
        bid_amount DECIMAL(12,2) NOT NULL,
        bid_hash VARCHAR(128) NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        KEY idx_audit_auction (auction_id, asset_id, created_at),
        KEY idx_audit_wallet (bidder_wallet, created_at)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
    `);
    await db.execute(`
      CREATE TABLE IF NOT EXISTS auction_sales (
        id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
        auction_id BIGINT UNSIGNED NOT NULL,
        asset_id VARCHAR(255) NOT NULL,
        seller_wallet VARCHAR(128) NOT NULL,
        buyer_wallet VARCHAR(128) NOT NULL,
        price_usd DECIMAL(12,2) NOT NULL,
        tx_hash VARCHAR(128),
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        KEY idx_auction_sales_asset (asset_id),
        KEY idx_auction_sales_buyer (buyer_wallet, created_at)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
    `);
    await db.execute(`
      CREATE TABLE IF NOT EXISTS certificate_transfers (
        id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
        asset_id VARCHAR(255) NOT NULL,
        previous_owner VARCHAR(128) NOT NULL,
        new_owner VARCHAR(128) NOT NULL,
        transfer_type VARCHAR(50) DEFAULT 'transfer',
        tx_hash VARCHAR(128),
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        KEY idx_cert_transfers_asset (asset_id),
        KEY idx_cert_transfers_new_owner (new_owner)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
    `);
    console.log('Tablas de MySQL verificadas / creadas exitosamente.');
  } catch (err) {
    console.error('Error asegurando tablas de base de datos:', err);
  }
};

// ==========================================
// AUCTIONS CRUD
// ==========================================
async function enrichAuctionRows(rows) {
  const mapped = [];
  for (const row of rows) {
    let certProductName = null;
    let certImageUrl = null;
    try {
      const [certRows] = await db.execute(
        'SELECT product_name AS cert_product_name, image_url AS cert_image_url FROM certificates WHERE asset_id = ? OR id = ? LIMIT 1',
        [row.asset_id, row.asset_id]
      );
      if (certRows && certRows.length > 0) {
        certProductName = certRows[0].cert_product_name;
        certImageUrl = certRows[0].cert_image_url;
      }
    } catch (e) {
      console.warn('Warning enriching auction row:', e.message || e);
    }

    mapped.push({
      ...row,
      current_bid: Number(row.current_bid || 0),
      starting_price: Number(row.starting_price || 0),
      title: row.title || certProductName || `Auction ${row.asset_id}`,
      image: (row.image && String(row.image).trim()) ? String(row.image).trim() : (certImageUrl || null)
    });
  }
  return mapped;
}

async function cleanupExpiredUnbidAuctions() {
  try {
    await db.execute(
      `DELETE FROM auction_listings 
       WHERE end_time <= NOW() 
         AND (current_bidder_wallet IS NULL OR current_bidder_wallet = '')`
    );
  } catch (e) {
    console.warn('Warning auto-cleaning expired unbid auctions:', e.message || e);
  }
}

app.get('/api/auctions/listings', async (req, res) => {
  try {
    await cleanupExpiredUnbidAuctions();
    const [rows] = await db.execute(
      `SELECT * FROM auction_listings ORDER BY created_at DESC`
    );
    const mapped = await enrichAuctionRows(rows || []);
    res.json(mapped);
  } catch (err) {
    console.error('GET /api/auctions/listings error', err);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/auctions/seller/:wallet', async (req, res) => {
  try {
    await cleanupExpiredUnbidAuctions();
    const wallet = req.params.wallet;
    const [rows] = await db.execute(
      `SELECT * FROM auction_listings WHERE seller_wallet = ? ORDER BY created_at DESC`,
      [wallet]
    );
    const mapped = await enrichAuctionRows(rows || []);
    res.json(mapped);
  } catch (err) {
    console.error('GET /api/auctions/seller/:wallet error', err);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/auctions/my-bids/:wallet', async (req, res) => {
  try {
    const wallet = req.params.wallet;
    const [rows] = await db.execute(
      `SELECT a.id, a.auction_id, a.asset_id, a.bidder_wallet, a.bid_amount, a.created_at, a.bid_hash,
              l.title, l.status, l.end_time, l.image
       FROM auction_bid_audit a
       LEFT JOIN auction_listings l ON l.asset_id = a.asset_id
       WHERE a.bidder_wallet = ?
       ORDER BY a.created_at DESC`,
      [wallet]
    );

    const mapped = (rows || []).map(row => ({
      id: row.id,
      auction_id: row.auction_id,
      asset_id: row.asset_id,
      bidder_wallet: row.bidder_wallet,
      bid_amount: Number(row.bid_amount || 0),
      created_at: row.created_at,
      bid_hash: row.bid_hash,
      title: row.title || `Subasta ${row.asset_id}`,
      status: row.status || 'live',
      end_time: row.end_time,
      image: row.image,
    }));

    res.json(mapped);
  } catch (err) {
    console.error('GET /api/auctions/my-bids/:wallet error', err);
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/auctions/list', async (req, res) => {
  try {
    const { asset_id, seller_wallet, starting_price, reserve_price, end_time, description, title, image, category } = req.body;
    if (!asset_id || !seller_wallet || !starting_price || !end_time) {
      return res.status(400).json({ error: 'asset_id, seller_wallet, starting_price y end_time son requeridos' });
    }

    const normalizedEndTime = String(end_time).includes('T')
      ? String(end_time).replace('T', ' ').replace('Z', '').slice(0, 19)
      : String(end_time).slice(0, 19);

    try {
      const payload = { jsonrpc: '2.0', id: 'verify-owner-auction', method: 'getAssetsByOwner', params: { ownerAddress: seller_wallet, page: 1, limit: 1000 } };
      const verifyRes = await fetch(DAS_RPC_URL, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
      if (verifyRes.ok) {
        const verifyJson = await verifyRes.json();
        const candidates = verifyJson.result?.assets || verifyJson.result?.items || verifyJson.result || verifyJson.assets || [];
        const rawAssets = Array.isArray(candidates) ? candidates : (Array.isArray(verifyJson.result?.data) ? verifyJson.result.data : []);
        const ownedIds = new Set(rawAssets.map(a => String(a.id || a.assetId || a.mint || '')));
        if (!ownedIds.has(String(asset_id))) {
          return res.status(400).json({ error: 'El seller_wallet no posee el asset_id indicado según DAS RPC' });
        }
      } else {
        return res.status(500).json({ error: 'No se pudo verificar propiedad via DAS RPC' });
      }
    } catch (e) {
      console.error('Error verifying auction owner via DAS RPC:', e);
      return res.status(500).json({ error: 'Fallo la verificación de propiedad (DAS RPC)' });
    }

    const [existing] = await db.execute('SELECT * FROM auction_listings WHERE asset_id = ?', [asset_id]);
    if (existing && existing.length > 0) return res.status(409).json({ error: 'Este asset ya está en subasta' });

    let finalTitle = title || null;
    let finalImage = image || null;
    try {
      const [certRows] = await db.execute('SELECT * FROM certificates WHERE asset_id = ? OR id = ?', [asset_id, asset_id]);
      if (certRows && certRows.length > 0) {
        const cert = certRows[0];
        finalTitle = finalTitle || cert.product_name || `Certificado ${cert.id || asset_id}`;
        finalImage = finalImage || cert.image_url || null;
      }
    } catch (e) { /* ignore */ }

    if (!finalImage && seller_wallet) {
      try {
        const payload = { jsonrpc: '2.0', id: 'auction-image-lookup', method: 'getAssetsByOwner', params: { ownerAddress: seller_wallet, page: 1, limit: 1000 } };
        const verifyRes = await fetch(DAS_RPC_URL, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
        if (verifyRes.ok) {
          const verifyJson = await verifyRes.json();
          const candidates = verifyJson.result?.assets || verifyJson.result?.items || verifyJson.result || verifyJson.assets || [];
          const rawAssets = Array.isArray(candidates) ? candidates : (Array.isArray(verifyJson.result?.data) ? verifyJson.result.data : []);
          const asset = rawAssets.find((item) => String(item.id || item.assetId || item.mint || '') === String(asset_id));
          if (asset) {
            finalImage = asset.content?.links?.image || asset.content?.files?.[0]?.uri || asset.image_url || finalImage;
          }
        }
      } catch (e) {
        console.warn('No se pudo resolver la imagen del NFT para la subasta:', e.message || e);
      }
    }

    const [result] = await db.execute(
      `INSERT INTO auction_listings (asset_id, seller_wallet, starting_price, current_bid, current_bidder_wallet, reserve_price, end_time, status, description, title, image, category)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'live', ?, ?, ?, ?)`,
      [asset_id, seller_wallet, Number(starting_price), Number(starting_price), null, Number(reserve_price || starting_price || 0), normalizedEndTime, description || null, finalTitle, finalImage, category || null]
    );

    const [rows] = await db.execute('SELECT * FROM auction_listings WHERE id = ?', [result.insertId]);
    res.json(rows[0]);
  } catch (err) {
    console.error('POST /api/auctions/list error', err);
    res.status(500).json({ error: err.message });
  }
});

app.put('/api/auctions/list/:assetId', async (req, res) => {
  try {
    const assetId = req.params.assetId;
    const { title, starting_price, current_bid, reserve_price, end_time, description, category, image, status } = req.body;
    const updates = [];
    const params = [];
    const normalizedEndTime = end_time !== undefined && String(end_time).includes('T')
      ? String(end_time).replace('T', ' ').replace('Z', '').slice(0, 19)
      : end_time;
    const allowed = [
      ['title', title],
      ['starting_price', starting_price],
      ['current_bid', current_bid],
      ['reserve_price', reserve_price],
      ['end_time', normalizedEndTime],
      ['description', description],
      ['category', category],
      ['image', image],
      ['status', status],
    ];
    for (const [key, value] of allowed) {
      if (value !== undefined) {
        updates.push(`${key} = ?`);
        params.push(value);
      }
    }
    if (!updates.length) return res.status(400).json({ error: 'No hay campos válidos para actualizar' });
    params.push(assetId);
    await db.execute(`UPDATE auction_listings SET ${updates.join(', ')} WHERE asset_id = ?`, params);
    const [rows] = await db.execute('SELECT * FROM auction_listings WHERE asset_id = ?', [assetId]);
    if (!rows || rows.length === 0) return res.status(404).json({ error: 'Subasta no encontrada' });
    res.json(rows[0]);
  } catch (err) {
    console.error('PUT /api/auctions/list/:assetId error', err);
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/auctions/list/:assetId', async (req, res) => {
  try {
    const assetId = req.params.assetId;
    await db.execute('DELETE FROM auction_listings WHERE asset_id = ?', [assetId]);
    res.json({ success: true });
  } catch (err) {
    console.error('DELETE /api/auctions/list/:assetId error', err);
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/auctions/bid', async (req, res) => {
  try {
    const { asset_id, bidder_wallet, bid_amount } = req.body;
    if (!asset_id || !bidder_wallet || !bid_amount) {
      return res.status(400).json({ error: 'asset_id, bidder_wallet y bid_amount son requeridos' });
    }

    const [rows] = await db.execute('SELECT * FROM auction_listings WHERE asset_id = ?', [asset_id]);
    if (!rows || rows.length === 0) return res.status(404).json({ error: 'Subasta no encontrada' });

    const auction = rows[0];
    const bidValue = Number(bid_amount);
    const isAuctionActive = auction.status === 'live';
    const isAuctionExpired = new Date(auction.end_time).getTime() <= Date.now();

    const [existingBidRows] = await db.execute(
      'SELECT * FROM auction_bids WHERE auction_id = ? AND asset_id = ? AND bidder_wallet = ? ORDER BY created_at DESC LIMIT 1',
      [auction.id, asset_id, bidder_wallet]
    );

    const [sameAmountRows] = await db.execute(
      'SELECT * FROM auction_bids WHERE auction_id = ? AND asset_id = ? AND bidder_wallet = ? AND bid_amount = ? LIMIT 1',
      [auction.id, asset_id, bidder_wallet, bidValue]
    );

    const validationError = getBidValidationError({
      currentBid: auction.current_bid,
      bidValue,
      lastBidByWallet: existingBidRows && existingBidRows.length > 0 ? existingBidRows[0] : null,
      duplicateAcceptedBid: Boolean(sameAmountRows && sameAmountRows.length > 0),
      isAuctionActive,
      isAuctionExpired,
    });

    if (validationError) {
      return res.status(400).json({ error: validationError });
    }

    const bidHash = `bid-${auction.id}-${asset_id}-${bidder_wallet}-${Date.now()}-${bidValue.toFixed(2)}`;

    await db.execute(
      'INSERT INTO auction_bids (auction_id, asset_id, bidder_wallet, bid_amount) VALUES (?, ?, ?, ?)',
      [auction.id, asset_id, bidder_wallet, bidValue]
    );

    const [[insertedBid]] = await db.execute(
      'SELECT * FROM auction_bids WHERE auction_id = ? AND asset_id = ? AND bidder_wallet = ? AND bid_amount = ? ORDER BY created_at DESC LIMIT 1',
      [auction.id, asset_id, bidder_wallet, bidValue]
    );

    await db.execute(
      'INSERT INTO auction_bid_audit (auction_id, asset_id, bidder_wallet, bid_amount, bid_hash) VALUES (?, ?, ?, ?, ?)',
      [auction.id, asset_id, bidder_wallet, bidValue, bidHash]
    );

    await db.execute(
      'UPDATE auction_listings SET current_bid = ?, current_bidder_wallet = ? WHERE asset_id = ?',
      [bidValue, bidder_wallet, asset_id]
    );

    res.json({
      success: true,
      message: 'Puja registrada',
      bid_amount: bidValue,
      audit_id: insertedBid?.id || null,
      bid_hash: bidHash,
      current_bid: bidValue,
      current_bidder_wallet: bidder_wallet,
    });
  } catch (err) {
    console.error('POST /api/auctions/bid error', err);
    res.status(500).json({ error: err.message });
  }
});

// Claim / settle an ended auction (called by the winning bidder client after signing on-chain)
app.post('/api/auctions/claim', async (req, res) => {
  try {
    const { asset_id, buyer_wallet, tx_hash, bid_amount } = req.body;
    if (!asset_id || !buyer_wallet || !bid_amount) return res.status(400).json({ error: 'asset_id, buyer_wallet y bid_amount son requeridos' });

    const [rows] = await db.execute('SELECT * FROM auction_listings WHERE asset_id = ?', [asset_id]);
    if (!rows || rows.length === 0) return res.status(404).json({ error: 'Subasta no encontrada' });
    const auction = rows[0];

    const isExpired = new Date(auction.end_time).getTime() <= Date.now();
    if (!isExpired) return res.status(400).json({ error: 'La subasta aun no ha finalizado' });

    // Validate buyer is the current highest bidder
    if (!auction.current_bidder_wallet || String(auction.current_bidder_wallet) !== String(buyer_wallet)) {
      return res.status(403).json({ error: 'Solo el postor ganador puede reclamar la subasta' });
    }

    const salePrice = Number(bid_amount || auction.current_bid || 0);

    // Record auction sale
    try {
      await db.execute(
        'INSERT INTO auction_sales (auction_id, asset_id, seller_wallet, buyer_wallet, price_usd, tx_hash) VALUES (?, ?, ?, ?, ?, ?)',
        [auction.id, asset_id, auction.seller_wallet, buyer_wallet, salePrice, tx_hash || null]
      );
      console.log('Auction sale recorded: asset=' + asset_id + ', buyer=' + buyer_wallet + ', price=' + salePrice);
    } catch (e) {
      console.warn('Warning: Could not insert auction_sales:', e.message || e);
    }

    // Remove listing
    await db.execute('DELETE FROM auction_listings WHERE asset_id = ?', [asset_id]);

    // Record auction transfer
    try {
      await db.execute(
        'INSERT INTO certificate_transfers (asset_id, previous_owner, new_owner, transfer_type, tx_hash) VALUES (?, ?, ?, ?, ?)',
        [asset_id, auction.seller_wallet, buyer_wallet, 'auction_sale', tx_hash || null]
      );
    } catch (e) {
      console.warn('Warning: Could not insert certificate_transfers:', e.message || e);
    }

    // Update certificate owner off-chain if exists
    try {
      const [certCheck] = await db.execute('SELECT id, owner_wallet FROM certificates WHERE asset_id = ? OR id = ?', [asset_id, asset_id]);
      if (certCheck && certCheck.length > 0) {
        const cert = certCheck[0];
        await db.execute('UPDATE certificates SET owner_wallet = ? WHERE id = ?', [buyer_wallet, cert.id]);
        console.log('Propiedad transferida en BD: from=' + cert.owner_wallet + ', to=' + buyer_wallet);
      } else {
        console.warn('Advertencia: Certificado no encontrado para asset_id=' + asset_id);
      }
    } catch (e) {
      console.warn('Advertencia: No se pudo actualizar certificado en BD:', e.message || e);
    }

    // Transferir cNFT on-chain en Solana via Bubblegum al ganador de la subasta
    let onChainTx = null;
    try {
      onChainTx = await transferCnftOnChain(asset_id, buyer_wallet);
    } catch (onChainErr) {
      console.warn('Advertencia: No se completó la transferencia cNFT on-chain en subasta:', onChainErr.message || onChainErr);
    }

    res.json({ success: true, asset_id, buyer_wallet, seller_wallet: auction.seller_wallet, price_usd: salePrice, tx_hash: tx_hash || null, on_chain_tx: onChainTx });
  } catch (err) {
    console.error('POST /api/auctions/claim error', err);
    res.status(500).json({ error: err.message || 'Error procesando reclamación de subasta' });
  }
});

app.get('/api/auctions/stats', async (req, res) => {
  try {
    const [rows] = await db.execute('SELECT COUNT(*) AS total_auctions, IFNULL(SUM(current_bid),0) AS total_bid_value FROM auction_listings WHERE status = "live"');
    const [bidsRows] = await db.execute('SELECT COUNT(*) AS total_bids FROM auction_bids');
    res.json({
      total_auctions: Number(rows[0]?.total_auctions || 0),
      total_bid_value: Number(rows[0]?.total_bid_value || 0),
      total_bids: Number(bidsRows[0]?.total_bids || 0)
    });
  } catch (err) {
    console.error('GET /api/auctions/stats error', err);
    res.status(500).json({ error: err.message });
  }
});

// Public listings (para mostrar en marketplace público)
app.get('/api/marketplace/listings', async (req, res) => {
  try {
    const [rows] = await db.execute(
      `SELECT m.*, c.product_name as cert_product_name, c.image_url as cert_image_url
       FROM marketplace_listings m
       LEFT JOIN certificates c ON (m.asset_id = c.asset_id OR m.asset_id = c.id)
       ORDER BY m.created_at DESC`
    );
    const mapped = rows.map(r => ({
      ...r,
      title: r.title || r.cert_product_name || r.title,
      image: r.image || r.cert_image_url || r.image
    }));
    res.json(mapped);
  } catch (err) {
    console.error('GET /api/marketplace/listings error', err);
    res.status(500).json({ error: err.message });
  }
});

// Get seller listings
app.get('/api/marketplace/seller/:wallet', async (req, res) => {
  try {
    const wallet = req.params.wallet;
    const [rows] = await db.execute(
      `SELECT m.*, c.product_name as cert_product_name, c.image_url as cert_image_url
       FROM marketplace_listings m
       LEFT JOIN certificates c ON (m.asset_id = c.asset_id OR m.asset_id = c.id)
       WHERE m.seller_wallet = ?
       ORDER BY m.created_at DESC`,
      [wallet]
    );
    const mapped = rows.map(r => ({
      ...r,
      title: r.title || r.cert_product_name || r.title,
      image: r.image || r.cert_image_url || r.image
    }));
    res.json(mapped);
  } catch (err) {
    console.error('GET /api/marketplace/seller/:wallet error', err);
    res.status(500).json({ error: err.message });
  }
});

// Create a listing
app.post('/api/marketplace/list', async (req, res) => {
  try {
    const { asset_id, seller_wallet, price_usd, description, title, image, category } = req.body;
    if (!asset_id || !seller_wallet || !price_usd) return res.status(400).json({ error: 'asset_id, seller_wallet y price_usd son requeridos' });

    // Verify ownership server-side via DAS RPC to prevent false listings
    try {
      const payload = { jsonrpc: '2.0', id: 'verify-owner', method: 'getAssetsByOwner', params: { ownerAddress: seller_wallet, page: 1, limit: 1000 } };
      const verifyRes = await fetch(DAS_RPC_URL, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
      if (verifyRes.ok) {
        const verifyJson = await verifyRes.json();
        const candidates = verifyJson.result?.assets || verifyJson.result?.items || verifyJson.result || verifyJson.assets || [];
        const rawAssets = Array.isArray(candidates) ? candidates : (Array.isArray(verifyJson.result?.data) ? verifyJson.result.data : []);
        const ownedIds = new Set(rawAssets.map(a => String(a.id || a.assetId || a.mint || '')));
        if (!ownedIds.has(String(asset_id))) {
          return res.status(400).json({ error: 'El seller_wallet no posee el asset_id indicado según DAS RPC' });
        }
      } else {
        console.warn('DAS verification RPC returned non-ok status:', verifyRes.status);
        return res.status(500).json({ error: 'No se pudo verificar propiedad via DAS RPC' });
      }
    } catch (e) {
      console.error('Error verifying owner via DAS RPC:', e);
      return res.status(500).json({ error: 'Fallo la verificación de propiedad (DAS RPC)' });
    }

    // Preferir metadata almacenada en certificates si existe
    let finalTitle = title || null;
    let finalImage = image || null;
    try {
      const [certRows] = await db.execute('SELECT * FROM certificates WHERE asset_id = ? OR id = ?', [asset_id, asset_id]);
      if (certRows && certRows.length > 0) {
        const cert = certRows[0];
        finalTitle = finalTitle || cert.product_name || cert.name || (`Certificado ${cert.id || asset_id}`);
        finalImage = finalImage || cert.image_url || null;
      }
    } catch (e) {
      // ignore
    }

    // Si ya existe un listing con mismo asset_id, responder con 409
    const [existing] = await db.execute('SELECT * FROM marketplace_listings WHERE asset_id = ?', [asset_id]);
    if (existing && existing.length > 0) return res.status(409).json({ error: 'Este asset ya está listado' });

    const [result] = await db.execute(
      `INSERT INTO marketplace_listings (asset_id, seller_wallet, price_usd, description, title, image, category) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [asset_id, seller_wallet, Number(price_usd), description || null, finalTitle, finalImage, category || null]
    );

    const insertedId = result.insertId;
    const [rows] = await db.execute('SELECT * FROM marketplace_listings WHERE id = ?', [insertedId]);
    res.json(rows[0]);
  } catch (err) {
    console.error('POST /api/marketplace/list error', err);
    res.status(500).json({ error: err.message });
  }
});

// Update a listing
app.put('/api/marketplace/list/:assetId', async (req, res) => {
  try {
    const { assetId } = req.params;
    const { title, price_usd, description, category, image } = req.body;
    if (!assetId) return res.status(400).json({ error: 'assetId es requerido' });
    // Update the listing
    await db.execute(
      'UPDATE marketplace_listings SET title = ?, price_usd = ?, description = ?, category = ?, image = ? WHERE asset_id = ?',
      [title || null, price_usd || 0, description || null, category || null, image || null, assetId]
    );
    const [rows] = await db.execute('SELECT * FROM marketplace_listings WHERE asset_id = ?', [assetId]);
    if (!rows || rows.length === 0) return res.status(404).json({ error: 'Listing no encontrado' });
    res.json(rows[0]);
  } catch (err) {
    console.error('PUT /api/marketplace/list/:assetId error', err);
    res.status(500).json({ error: err.message });
  }
});

// Update a listing partially (price, description, category)
app.put('/api/marketplace/list/:assetId', async (req, res) => {
  try {
    const assetId = req.params.assetId;
    const allowed = ['price_usd', 'description', 'category', 'title', 'image'];
    const updates = [];
    const params = [];
    for (const k of allowed) {
      if (Object.prototype.hasOwnProperty.call(req.body, k)) {
        updates.push(`${k} = ?`);
        params.push(req.body[k]);
      }
    }
    if (!updates.length) return res.status(400).json({ error: 'No hay campos válidos para actualizar' });
    params.push(assetId);
    const sql = `UPDATE marketplace_listings SET ${updates.join(', ')} WHERE asset_id = ?`;
    await db.execute(sql, params);
    const [rows] = await db.execute('SELECT * FROM marketplace_listings WHERE asset_id = ?', [assetId]);
    res.json(rows[0]);
  } catch (err) {
    console.error('PUT /api/marketplace/list/:assetId error', err);
    res.status(500).json({ error: err.message });
  }
});

// Delete a listing
app.delete('/api/marketplace/list/:assetId', async (req, res) => {
  try {
    const assetId = req.params.assetId;
    await db.execute('DELETE FROM marketplace_listings WHERE asset_id = ?', [assetId]);
    res.json({ success: true });
  } catch (err) {
    console.error('DELETE /api/marketplace/list/:assetId error', err);
    res.status(500).json({ error: err.message });
  }
});

async function transferCnftOnChain(assetIdStr, buyerWalletStr) {
  if (!process.env.COMPANY_PRIVATE_KEY) {
    console.warn('COMPANY_PRIVATE_KEY no está configurado en el backend. Omitiendo transferencia cNFT on-chain.');
    return null;
  }

  try {
    const rpcUrl = DAS_RPC_URL || process.env.SOLANA_RPC_URL || 'https://api.devnet.solana.com';
    const umi = createUmi(rpcUrl).use(mplBubblegum()).use(dasApi());

    const companySecretKey = bs58.decode(process.env.COMPANY_PRIVATE_KEY);
    const companyKeypair = Keypair.fromSecretKey(companySecretKey);
    const umiKeypair = fromWeb3JsKeypair(companyKeypair);
    umi.use(keypairIdentity(umiKeypair));

    const assetId = umiPublicKey(assetIdStr);
    const buyer = umiPublicKey(buyerWalletStr);

    console.log(`[ON-CHAIN] Obteniendo proof para cNFT ${assetIdStr}...`);
    const assetWithProof = await getAssetWithProof(umi, assetId, { truncateCanopy: true });

    if (assetWithProof.leafOwner.toString() === buyerWalletStr) {
      console.log(`[ON-CHAIN] cNFT ${assetIdStr} ya pertenece a ${buyerWalletStr} en blockchain.`);
      return 'already_owned';
    }

    console.log(`[ON-CHAIN] Enviando transaccion Bubblegum transfer para ${assetIdStr} de ${assetWithProof.leafOwner.toString()} a ${buyerWalletStr}...`);
    const txBuilder = await bubblegumTransfer(umi, {
      leafOwner: assetWithProof.leafOwner,
      newLeafOwner: buyer,
      merkleTree: assetWithProof.merkleTree,
      root: assetWithProof.root,
      dataHash: assetWithProof.dataHash,
      creatorHash: assetWithProof.creatorHash,
      nonce: assetWithProof.nonce,
      index: assetWithProof.index,
      proof: Array.isArray(assetWithProof.proof) ? assetWithProof.proof : [],
    }).sendAndConfirm(umi, { commitment: 'confirmed' });

    const sig = bs58.encode(txBuilder.signature);
    console.log(`[ON-CHAIN] ✅ cNFT ${assetIdStr} transferido exitosamente en blockchain a ${buyerWalletStr}. Signature: ${sig}`);
    return sig;
  } catch (err) {
    console.error(`[ON-CHAIN] ❌ Error transfiriendo cNFT ${assetIdStr} en backend:`, err.message || err);
    return null;
  }
}

// Comprar un producto (eliminar de marketplace y transferir propiedad en BD)
app.post('/api/marketplace/buy', async (req, res) => {
  try {
    const { asset_id, buyer_wallet, tx_hash } = req.body;
    if (!asset_id || !buyer_wallet) {
      return res.status(400).json({ error: 'asset_id y buyer_wallet son requeridos' });
    }

    // Validar que buyer_wallet sea una dirección Solana válida
    try {
      new PublicKey(buyer_wallet);
    } catch (e) {
      return res.status(400).json({ error: 'buyer_wallet no es una dirección Solana válida' });
    }

    // 1. Find listing to capture seller and price
    const [rows] = await db.execute('SELECT * FROM marketplace_listings WHERE asset_id = ?', [asset_id]);
    if (!rows || rows.length === 0) return res.status(404).json({ error: 'Listing no encontrado' });
    const listing = rows[0];

    // 2. Validate seller wallet format
    try {
      new PublicKey(listing.seller_wallet);
    } catch (e) {
      return res.status(400).json({ error: 'seller_wallet en listing no es válida' });
    }

    // 3. Record sale with tx_hash
    const saleRecordTx = tx_hash || null;
    try {
      await db.execute(
        'INSERT INTO marketplace_sales (asset_id, seller_wallet, buyer_wallet, price_usd, tx_hash) VALUES (?, ?, ?, ?, ?)',
        [asset_id, listing.seller_wallet, buyer_wallet, listing.price_usd || 0, saleRecordTx]
      );
      console.log('Venta registrada: asset=' + asset_id + ', buyer=' + buyer_wallet);
    } catch (e) {
      console.warn('Advertencia: No se pudo registrar venta:', e.message);
    }

    // 4. Eliminar listing del marketplace
    await db.execute('DELETE FROM marketplace_listings WHERE asset_id = ?', [asset_id]);
    console.log('Listing eliminado del marketplace: asset=' + asset_id);

    // 5. Actualizar owner_wallet en certificados
    const [certCheck] = await db.execute(
      'SELECT id, owner_wallet FROM certificates WHERE asset_id = ? OR id = ?',
      [asset_id, asset_id]
    );

    if (certCheck && certCheck.length > 0) {
      const cert = certCheck[0];
      const previousOwner = cert.owner_wallet;
      
      await db.execute(
        'UPDATE certificates SET owner_wallet = ? WHERE id = ?',
        [buyer_wallet, cert.id]
      );
      
      console.log('Propiedad transferida en BD: from=' + previousOwner + ', to=' + buyer_wallet);
    } else {
      console.warn('Advertencia: Certificado no encontrado para asset_id=' + asset_id);
    }

    // Registrar en certificate_transfers
    try {
      await db.execute(
        'INSERT INTO certificate_transfers (asset_id, previous_owner, new_owner, transfer_type, tx_hash) VALUES (?, ?, ?, ?, ?)',
        [asset_id, listing.seller_wallet, buyer_wallet, 'marketplace_sale', saleRecordTx]
      );
    } catch (e) {
      console.warn('Advertencia: No se pudo registrar en certificate_transfers:', e.message);
    }

    // 6. Transferir cNFT on-chain en Solana via Bubblegum
    let onChainTx = null;
    try {
      onChainTx = await transferCnftOnChain(asset_id, buyer_wallet);
    } catch (onChainErr) {
      console.warn('Advertencia: No se completó la transferencia on-chain:', onChainErr.message || onChainErr);
    }

    res.json({
      success: true,
      message: 'Producto adquirido exitosamente. Certificados transferidos a tu wallet.',
      asset_id,
      buyer_wallet,
      seller_wallet: listing.seller_wallet,
      price_usd: listing.price_usd,
      tx_hash: saleRecordTx,
      on_chain_tx: onChainTx
    });
  } catch (err) {
    console.error('POST /api/marketplace/buy error', err);
    res.status(500).json({ error: err.message || 'Error procesando compra' });
  }
});

// Marketplace stats: simple KPIs used by dashboard cards
app.get('/api/marketplace/stats', async (req, res) => {
  try {
    const [totalRows] = await db.execute('SELECT COUNT(*) AS total_listings FROM marketplace_listings');
    const total_listings = totalRows[0]?.total_listings || 0;

    const [recentRows] = await db.execute("SELECT COUNT(*) AS recent_listings, IFNULL(SUM(price_usd),0) AS recent_value FROM marketplace_listings WHERE created_at >= DATE_SUB(NOW(), INTERVAL 30 DAY)");
    const recent_listings = recentRows[0]?.recent_listings || 0;
    const recent_value = recentRows[0]?.recent_value || 0;

    // Estimate new certificates in last 30 days (minted/created records)
    const [newCertsRows] = await db.execute("SELECT COUNT(*) AS new_certs FROM certificates WHERE created_at >= DATE_SUB(NOW(), INTERVAL 30 DAY) AND owner_wallet IS NOT NULL");
    const new_certs = newCertsRows[0]?.new_certs || 0;

    res.json({
      total_listings: Number(total_listings),
      recent_listings: Number(recent_listings),
      recent_value: Number(recent_value),
      new_certs: Number(new_certs)
    });
  } catch (err) {
    console.error('GET /api/marketplace/stats error', err);
    res.status(500).json({ error: err.message });
  }
});


app.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 Servidor ejecutándose en el puerto ${PORT}`);

  // Iniciar la verificación de tablas en segundo plano sin congelar el arranque
  ensureDatabaseTables().catch(err => {
    console.error('Error inicializando esquema de BD:', err);
  });
});