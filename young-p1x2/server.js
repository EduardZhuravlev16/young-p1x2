const express = require('express');
const WebSocket = require('ws');
const path = require('path');
const fs = require('fs');
const axios = require('axios');
const bodyParser = require('body-parser');

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(express.static('public'));
app.use(bodyParser.json({ limit: '50mb' }));
app.use(bodyParser.urlencoded({ extended: true, limit: '50mb' }));

// HTTP сервер
const server = app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});

// WebSocket сервер
const wss = new WebSocket.Server({ server });

// Хранение данных
const clients = new Map(); // Map<ws, {role: string, lastActivity: Date}>
const screenshots = new Map(); // Map<questionId, screenshotData>

// Обработка WebSocket соединений
wss.on('connection', (ws) => {
  console.log('New WebSocket connection');
  
  ws.on('message', (message) => {
    try {
      const data = JSON.parse(message);
      
      // Регистрация клиента
      if (data.role) {
        clients.set(ws, { 
          role: data.role,
          lastActivity: new Date()
        });
        console.log(`Client registered as ${data.role}`);
        return;
      }
      
      // Обработка скриншотов от helper
      if (data.type === 'screenshot') {
        handleScreenshot(ws, data);
        return;
      }
      
      // Обработка ответов от receiver
      if (data.type === 'answer') {
        handleAnswer(ws, data);
        return;
      }
      
      // Обработка HTML страницы
      if (data.type === 'pageHTML') {
        console.log('Received page HTML');
        broadcastToReceivers({
          type: 'pageHTML',
          html: data.html,
          timestamp: new Date().toISOString()
        });
        return;
      }
      
    } catch (e) {
      console.error('Error processing message:', e);
    }
  });
  
  ws.on('close', () => {
    clients.delete(ws);
    console.log('Client disconnected');
  });
});

function handleScreenshot(ws, data) {
  const clientData = clients.get(ws);
  if (!clientData || clientData.role !== 'helper') {
    console.log('Screenshot received from non-helper client');
    return;
  }
  
  console.log(`Received screenshot with questionId: ${data.questionId}`);
  
  // Сохраняем скриншот
  screenshots.set(data.questionId, {
    screenshot: data.screenshot,
    timestamp: new Date().toISOString()
  });
  
  // Отправляем получателям
  broadcastToReceivers({
    type: 'new_screenshot',
    questionId: data.questionId,
    screenshot: data.screenshot,
    timestamp: new Date().toISOString()
  });
}

function handleAnswer(ws, data) {
  const clientData = clients.get(ws);
  if (!clientData || clientData.role !== 'receiver') {
    console.log('Answer received from non-receiver client');
    return;
  }
  
  console.log(`Received answer for questionId: ${data.questionId}`);
  
  // Отправляем ответ помощнику
  broadcastToHelpers({
    type: 'answer',
    questionId: data.questionId,
    answer: data.answer,
    timestamp: new Date().toISOString()
  });
}

function broadcastToReceivers(data) {
  wss.clients.forEach(client => {
    const clientData = clients.get(client);
    if (clientData && clientData.role === 'receiver' && client.readyState === WebSocket.OPEN) {
      client.send(JSON.stringify(data));
    }
  });
}

function broadcastToHelpers(data) {
  wss.clients.forEach(client => {
    const clientData = clients.get(client);
    if (clientData && clientData.role === 'helper' && client.readyState === WebSocket.OPEN) {
      client.send(JSON.stringify(data));
    }
  });
}

// API для проксирования изображений
app.get('/proxy-image', async (req, res) => {
  try {
    const url = req.query.url;
    if (!url) {
      return res.status(400).send('URL parameter is required');
    }
    
    const response = await axios.get(url, { responseType: 'arraybuffer' });
    const contentType = response.headers['content-type'] || 'image/png';
    
    res.set('Content-Type', contentType);
    res.send(response.data);
    
  } catch (error) {
    console.error('Proxy error:', error);
    res.status(500).send('Error fetching image');
  }
});

// API для загрузки скриншотов
app.post('/upload-screenshot', (req, res) => {
  try {
    const { screenshot, questionId } = req.body;
    
    if (!screenshot || !questionId) {
      return res.status(400).json({ error: 'Missing screenshot or questionId' });
    }
    
    // Сохраняем в памяти
    screenshots.set(questionId, {
      screenshot,
      timestamp: new Date().toISOString()
    });
    
    // Отправляем получателям
    broadcastToReceivers({
      type: 'new_screenshot',
      questionId,
      screenshot,
      timestamp: new Date().toISOString()
    });
    
    res.json({ success: true });
    
  } catch (error) {
    console.error('Upload error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Очистка старых скриншотов каждые 24 часа
setInterval(() => {
  const now = new Date();
  const twentyFourHoursAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000);
  
  screenshots.forEach((value, key) => {
    if (new Date(value.timestamp) < twentyFourHoursAgo) {
      screenshots.delete(key);
    }
  });
}, 24 * 60 * 60 * 1000);