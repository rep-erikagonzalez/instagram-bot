const express = require('express');
const axios = require('axios');
const sqlite3 = require('sqlite3').verbose();
const TelegramBot = require('node-telegram-bot-api');
const Anthropic = require('@anthropic-ai/sdk');
require('dotenv').config();

const app = express();
app.use(express.json());

// ============= CREDENCIALES =============
const IG_ACCESS_TOKEN = process.env.IG_ACCESS_TOKEN;
const IG_BUSINESS_ACCOUNT_ID = process.env.IG_BUSINESS_ACCOUNT_ID;
const WEBHOOK_VERIFY_TOKEN = process.env.WEBHOOK_VERIFY_TOKEN;
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const INSTRUCCIONES_SISTEMA = process.env.INSTRUCCIONES_SISTEMA || 'Eres un asistente de atención al cliente amable, profesional y eficiente.';

// ============= INICIALIZAR CLIENTES =============
const client = new Anthropic();
const telegramBot = TELEGRAM_BOT_TOKEN ? new TelegramBot(TELEGRAM_BOT_TOKEN, { polling: false }) : null;

// ============= BASE DE DATOS =============
const db = new sqlite3.Database('./mensajes.db', (err) => {
  if (err) console.error('Error abriendo BD:', err);
  else console.log('✅ Base de datos conectada');
});

// Crear tablas
db.serialize(() => {
  db.run(`
    CREATE TABLE IF NOT EXISTS mensajes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      sender_id TEXT NOT NULL,
      sender_name TEXT,
      mensaje_texto TEXT NOT NULL,
      respuesta_texto TEXT,
      tiempo_respuesta_ms INTEGER,
      fecha DATETIME DEFAULT CURRENT_TIMESTAMP,
      procesado INTEGER DEFAULT 1
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS usuarios (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      sender_id TEXT UNIQUE NOT NULL,
      nombre TEXT,
      primer_contacto DATETIME DEFAULT CURRENT_TIMESTAMP,
      total_mensajes INTEGER DEFAULT 1,
      ultima_interaccion DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);
});

// ============= FUNCIONES AUXILIARES =============

// Guardar mensaje en BD
async function guardarMensaje(sender_id, sender_name, mensaje, respuesta, tiempoMs) {
  return new Promise((resolve, reject) => {
    db.run(
      `INSERT INTO mensajes (sender_id, sender_name, mensaje_texto, respuesta_texto, tiempo_respuesta_ms) 
       VALUES (?, ?, ?, ?, ?)`,
      [sender_id, sender_name, mensaje, respuesta, tiempoMs],
      function(err) {
        if (err) {
          console.error('Error guardando mensaje:', err);
          reject(err);
        } else {
          console.log(`💾 Mensaje guardado (ID: ${this.lastID})`);
          resolve(this.lastID);
        }
      }
    );
  });
}

// Actualizar o crear usuario
async function registrarUsuario(sender_id, sender_name) {
  return new Promise((resolve, reject) => {
    db.run(
      `INSERT INTO usuarios (sender_id, nombre, total_mensajes, ultima_interaccion)
       VALUES (?, ?, 1, CURRENT_TIMESTAMP)
       ON CONFLICT(sender_id) DO UPDATE SET 
       total_mensajes = total_mensajes + 1,
       ultima_interaccion = CURRENT_TIMESTAMP`,
      [sender_id, sender_name],
      function(err) {
        if (err) reject(err);
        else resolve();
      }
    );
  });
}

// Notificar por Telegram
async function notificarTelegram(mensaje, sender_id, sender_name) {
  if (!telegramBot) return;
  
  try {
    const preview = mensaje.substring(0, 60).replace(/"/g, "'");
    const texto = `📩 <b>${sender_name}</b> (${sender_id})\n\n<code>"${preview}${mensaje.length > 60 ? '...' : ''}"</code>`;
    
    await telegramBot.sendMessage(TELEGRAM_CHAT_ID, texto, { parse_mode: 'HTML' });
  } catch (error) {
    console.error('Error notificando Telegram:', error.message);
  }
}

// Generar respuesta con IA automáticamente
async function generarRespuestaAutomatica(mensaje, nombreUsuario = 'Usuario') {
  try {
    const tiempoInicio = Date.now();

    const response = await client.messages.create({
      model: 'claude-3-5-sonnet-20241022',
      max_tokens: 200,
      system: `${INSTRUCCIONES_SISTEMA}

Reglas para responder DMs en Instagram:
- Responde en máximo 150 palabras
- Usa un tono cálido, profesional y amable
- Incluye 1-2 emojis naturales (sin exceso)
- Si preguntan por precios/planes, sugiere contactar o ver sitio web
- Sé conciso y directo
- Responde en el MISMO IDIOMA del cliente
- Si la pregunta es sobre producto/servicio, pregunta más detalles
- Si es consulta sobre estado de pedido, pide número de referencia
- Nunca prometas lo que no puedas cumplir`,
      messages: [
        { role: 'user', content: mensaje }
      ]
    });

    const tiempoRespuesta = Date.now() - tiempoInicio;
    const respuesta = response.content[0].text;

    return {
      respuesta,
      tiempoMs: tiempoRespuesta,
      modelo: 'claude-3-5-sonnet-20241022'
    };
  } catch (error) {
    console.error('Error con IA:', error.message);
    return {
      respuesta: 'Gracias por tu mensaje. Te responderemos pronto 😊',
      tiempoMs: 0,
      modelo: 'fallback',
      error: true
    };
  }
}

// Enviar respuesta por DM
async function enviarRespuestaDM(sender_id, respuesta) {
  try {
    const url = `https://graph.instagram.com/v18.0/${sender_id}/messages`;
    
    await axios.post(url, {
      message_type: 'MESSAGE_REQUEST',
      recipient_type: 'individual',
      message: {
        text: respuesta
      }
    }, {
      params: { access_token: IG_ACCESS_TOKEN }
    });

    console.log(`✉️ Respuesta enviada a ${sender_id}`);
    return true;
  } catch (error) {
    console.error('Error enviando respuesta:', error.response?.data || error.message);
    return false;
  }
}

// Procesar mensaje entrante
async function procesarMensajeEntrante(sender_id, sender_name, mensaje_texto) {
  console.log(`\n📨 Mensaje de ${sender_name} (${sender_id}): "${mensaje_texto}"`);

  const tiempoTotal = Date.now();

  try {
    // 1. Registrar usuario
    await registrarUsuario(sender_id, sender_name);

    // 2. Notificar por Telegram
    await notificarTelegram(mensaje_texto, sender_id, sender_name);

    // 3. Generar respuesta automáticamente con IA
    console.log('🤖 Generando respuesta...');
    const { respuesta, tiempoMs } = await generarRespuestaAutomatica(mensaje_texto, sender_name);

    // 4. Enviar respuesta
    const enviado = await enviarRespuestaDM(sender_id, respuesta);

    // 5. Guardar en BD
    if (enviado) {
      const tiempoTotalMs = Date.now() - tiempoTotal;
      await guardarMensaje(sender_id, sender_name, mensaje_texto, respuesta, tiempoTotalMs);
      console.log(`⏱️ Tiempo total: ${tiempoTotalMs}ms`);
    }

    return enviado;
  } catch (error) {
    console.error('Error procesando mensaje:', error);
    return false;
  }
}

// ============= WEBHOOK VERIFICATION =============
app.get('/webhook', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  if (mode && token) {
    if (mode === 'subscribe' && token === WEBHOOK_VERIFY_TOKEN) {
      console.log('✅ Webhook verificado');
      res.status(200).send(challenge);
    } else {
      res.sendStatus(403);
    }
  }
});

// ============= RECIBIR MENSAJES =============
app.post('/webhook', async (req, res) => {
  const body = req.body;

  if (body.object) {
    const entry = body.entry[0];
    
    if (entry.messaging) {
      const messaging = entry.messaging[0];

      if (messaging.message) {
        const sender_id = messaging.sender.id;
        const message_text = messaging.message.text;
        const sender_name = messaging.sender.name || sender_id;

        // Procesar de forma asíncrona (no esperar)
        procesarMensajeEntrante(sender_id, sender_name, message_text).catch(err => {
          console.error('Error en procesamiento:', err);
        });
      }
    }

    // Responder inmediatamente a Meta
    res.status(200).send('EVENT_RECEIVED');
  } else {
    res.sendStatus(404);
  }
});

// ============= ENDPOINTS DE ADMINISTRACIÓN =============

// Historial de mensajes
app.get('/historial/:sender_id', (req, res) => {
  const { sender_id } = req.params;
  const limit = req.query.limit || 20;

  db.all(
    `SELECT * FROM mensajes WHERE sender_id = ? ORDER BY fecha DESC LIMIT ?`,
    [sender_id, limit],
    (err, rows) => {
      if (err) {
        res.status(500).json({ error: 'Error consultando BD' });
      } else {
        res.json({ 
          usuario: sender_id, 
          total_mensajes: rows?.length || 0,
          mensajes: rows 
        });
      }
    }
  );
});

// Estadísticas
app.get('/estadisticas', (req, res) => {
  db.get(
    `SELECT 
      COUNT(DISTINCT sender_id) as total_usuarios,
      COUNT(*) as total_mensajes,
      ROUND(AVG(tiempo_respuesta_ms), 0) as tiempo_promedio_ms,
      MIN(tiempo_respuesta_ms) as tiempo_minimo_ms,
      MAX(tiempo_respuesta_ms) as tiempo_maximo_ms
    FROM mensajes WHERE tiempo_respuesta_ms > 0`,
    (err, row) => {
      if (err) {
        res.status(500).json({ error: 'Error consultando BD' });
      } else {
        res.json({
          ...row,
          tiempo_promedio_segundos: row?.tiempo_promedio_ms ? (row.tiempo_promedio_ms / 1000).toFixed(2) : 0
        });
      }
    }
  );
});

// Lista de usuarios
app.get('/usuarios', (req, res) => {
  db.all(
    `SELECT sender_id, nombre, total_mensajes, ultima_interaccion 
     FROM usuarios ORDER BY total_mensajes DESC`,
    (err, rows) => {
      if (err) {
        res.status(500).json({ error: 'Error consultando BD' });
      } else {
        res.json({ 
          usuarios: rows || [], 
          total: rows?.length || 0 
        });
      }
    }
  );
});

// Enviar mensaje manual
app.post('/enviar-mensaje', async (req, res) => {
  const { sender_id, mensaje } = req.body;

  if (!sender_id || !mensaje) {
    return res.status(400).json({ error: 'Falta sender_id o mensaje' });
  }

  try {
    const enviado = await enviarRespuestaDM(sender_id, mensaje);
    
    if (enviado) {
      await guardarMensaje(sender_id, 'Admin', '[Manual]', mensaje, 0);
      res.json({ success: true, mensaje: 'Mensaje enviado' });
    } else {
      res.status(500).json({ error: 'Error enviando mensaje' });
    }
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Test - enviar mensaje de prueba
app.post('/test-respuesta', async (req, res) => {
  const { mensaje } = req.body;

  if (!mensaje) {
    return res.status(400).json({ error: 'Falta "mensaje"' });
  }

  try {
    const { respuesta, tiempoMs } = await generarRespuestaAutomatica(mensaje);
    res.json({ 
      mensaje_entrada: mensaje,
      respuesta_generada: respuesta,
      tiempo_ms: tiempoMs,
      modelo: 'claude-3-5-sonnet-20241022'
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Health check
app.get('/health', (req, res) => {
  res.json({ 
    status: 'ok',
    timestamp: new Date().toISOString(),
    modo: '🤖 Respuestas completamente automáticas con IA',
    telegram_activo: !!telegramBot,
    base_datos: 'SQLite'
  });
});

// ============= INICIAR SERVIDOR =============
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`
╔════════════════════════════════════════════════════════════╗
║     🤖 BOT INSTAGRAM - RESPUESTAS COMPLETAMENTE AUTOMÁTICAS ║
║     ✅ Servidor iniciado - IA Claude respondiendo todos    ║
╚════════════════════════════════════════════════════════════╝

📍 Webhook en:        http://localhost:${PORT}/webhook
📊 Estadísticas:      GET http://localhost:${PORT}/estadisticas
👥 Usuarios:          GET http://localhost:${PORT}/usuarios
📜 Historial:         GET http://localhost:${PORT}/historial/:user_id
💬 Enviar manual:     POST http://localhost:${PORT}/enviar-mensaje
🧪 Test respuesta:    POST http://localhost:${PORT}/test-respuesta

⚙️  Configuración:
    - Modo: Respuestas automáticas 100% con IA
    - Modelo: Claude 3.5 Sonnet
    - BD: SQLite (historial completo)
    - Telegram: ${TELEGRAM_BOT_TOKEN ? '✅ Notificaciones activas' : '❌ No configurado'}

📝 Personalización:
    - Edita INSTRUCCIONES_SISTEMA en .env para cambiar comportamiento
    - El bot aprende del contexto automáticamente
  `);
});

// Manejar cierre
process.on('SIGINT', () => {
  console.log('\n👋 Cerrando bot...');
  db.close();
  process.exit(0);
});
