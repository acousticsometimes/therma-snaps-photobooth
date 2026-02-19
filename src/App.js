import React, { useState, useRef, useEffect, useCallback } from 'react';
import './App.css';
import { Printer, Wifi } from 'lucide-react';
import { createClient } from '@supabase/supabase-js';

// Images
import logoImg from './images/logo.png';
import element1Img from './images/element1.png';
import element2Img from './images/element2.png';
import homeHeroImg from './images/home-hero.png';

// Thermal Printer Class
class ThermalPrinter {
  constructor() {
    this.device = null;
    this.characteristic = null;
  }

  async connect() {
    try {
      this.device = await navigator.bluetooth.requestDevice({
        acceptAllDevices: true,
        optionalServices: ['000018f0-0000-1000-8000-00805f9b34fb']
      });

      const server = await this.device.gatt.connect();
      const service = await server.getPrimaryService('000018f0-0000-1000-8000-00805f9b34fb');
      this.characteristic = await service.getCharacteristic('00002af1-0000-1000-8000-00805f9b34fb');
      return true;
    } catch (error) {
      console.error('Connection failed:', error);
      throw error;
    }
  }

  async printImage(imageDataUrl) {
    if (!this.device || !this.device.gatt.connected) {
      throw new Error('Printer not connected');
    }

    const img = new Image();
    await new Promise((resolve, reject) => {
      img.onload = resolve;
      img.onerror = reject;
      img.src = imageDataUrl;
    });

    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d');
    const printerWidth = 384;
    const aspectRatio = img.height / img.width;
    canvas.width = printerWidth;
    canvas.height = Math.floor(printerWidth * aspectRatio);

    ctx.fillStyle = '#FFFFFF';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    
    // Increase contrast/brightness for cleaner thermal output
    ctx.filter = 'contrast(1.1) brightness(1.1)';
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
    ctx.filter = 'none';

    const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
    const thermalData = this.convertToESCPOS(imageData);

    // Smaller chunks + delay = smoother printing without stuttering
    const chunkSize = 512; // Increased to prevent buffer underrun (lines)
    for (let i = 0; i < thermalData.length; i += chunkSize) {
      const chunk = thermalData.slice(i, i + chunkSize);
      await this.characteristic.writeValue(chunk);
    }
  }

  applyDithering(imageData) {
    const width = imageData.width;
    const height = imageData.height;
    const data = new Float32Array(imageData.data);
    
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const idx = (y * width + x) * 4;
        let gray = data[idx] * 0.299 + data[idx + 1] * 0.587 + data[idx + 2] * 0.114;
        if (gray > 255) gray = 255;
        const oldVal = gray;
        const newVal = oldVal < 128 ? 0 : 255;
        const error = oldVal - newVal;
        
        data[idx] = newVal;
        
        const distribute = (dx, dy, factor) => {
            if (x + dx >= 0 && x + dx < width && y + dy >= 0 && y + dy < height) {
                const nIdx = ((y + dy) * width + (x + dx)) * 4;
                const v = data[nIdx] + error * factor;
                data[nIdx] = data[nIdx+1] = data[nIdx+2] = v;
            }
        };

        distribute(1, 0, 7/16);
        distribute(-1, 1, 3/16);
        distribute(0, 1, 5/16);
        distribute(1, 1, 1/16);
      }
    }
    
    const finalData = new Uint8ClampedArray(data.length);
    for (let i = 0; i < data.length; i++) {
        finalData[i] = data[i] < 128 ? 0 : 255;
    }
    
    return { width, height, data: finalData };
  }

  convertToESCPOS(imageData) {
    const { width, height, data } = this.applyDithering(imageData);
    const commands = [];

    // Initialize printer
    commands.push(0x1B, 0x40);

    // GS v 0 - Raster Bit Image
    // m=0, xL, xH, yL, yH
    const bytesPerLine = Math.ceil(width / 8);
    commands.push(0x1D, 0x76, 0x30, 0);
    commands.push(bytesPerLine & 0xff);
    commands.push((bytesPerLine >> 8) & 0xff);
    commands.push(height & 0xff);
    commands.push((height >> 8) & 0xff);

    for (let y = 0; y < height; y++) {
      for (let x = 0; x < bytesPerLine; x++) {
        let byte = 0;
        for (let b = 0; b < 8; b++) {
          const pixelX = x * 8 + b;
          if (pixelX < width) {
            const offset = (y * width + pixelX) * 4;
            // 0 is black (print), 255 is white (no print)
            if (data[offset] === 0) {
              byte |= (1 << (7 - b));
            }
          }
        }
        commands.push(byte);
      }
    }

    commands.push(0x1B, 0x64, 0x02); // Reduced feed to save paper
    commands.push(0x1D, 0x56, 0x01);
    return new Uint8Array(commands);
  }

  disconnect() {
    if (this.device && this.device.gatt.connected) {
      this.device.gatt.disconnect();
    }
  }
}

// --- STORAGE SERVICE ---

// SUPABASE CONFIGURATION
// Replace these with your actual Supabase project details
const supabaseUrl = process.env.REACT_APP_SUPABASE_URL;
const supabaseKey = process.env.REACT_APP_SUPABASE_ANON_KEY;

// Initialize Supabase only if keys are present to prevent crashes during dev
const supabase = createClient(supabaseUrl, supabaseKey);

const SupabaseService = {
  set: async (key, value) => {
    if (!supabase) {
      console.warn("Supabase not configured. Falling back to LocalStorage (QR codes won't work on other devices).");
      localStorage.setItem(key, value);
      return;
    }

    const data = JSON.parse(value);
    
    // 1. Upload image to Storage (saves DB space)
    // Convert base64 to blob
    const imageBlob = await (await fetch(data.image)).blob();
    const ext = (data.isGif === true) ? 'gif' : 'png';
    const filename = `${key}.${ext}`;

    const { error: uploadError } = await supabase.storage
      .from('photos')
      .upload(filename, imageBlob, { upsert: true });
      
    if (uploadError) {
      console.error("Supabase Upload Error:", uploadError);
      if (uploadError.message && uploadError.message.includes("Bucket not found")) {
        alert("SETUP REQUIRED: The 'photos' storage bucket is missing in Supabase. Please run the SQL setup script.");
      }
      throw uploadError;
    }

    // 2. Get Public URLs
    const { data: urlData } = supabase.storage
      .from('photos')
      .getPublicUrl(filename);

    // 3. Save Metadata to DB (storing the public URL instead of base64)
    const meta = { ...data };
    delete meta.image;
    const { error: dbError } = await supabase
      .from('photo_metadata')
      .upsert({ key, value: { ...meta, image: urlData.publicUrl } });
      
    if (dbError) throw dbError;
  },

  get: async (key) => {
    if (!supabase) {
      const value = localStorage.getItem(key);
      return value ? { value } : null;
    }

    const { data, error } = await supabase
      .from('photo_metadata')
      .select('value')
      .eq('key', key)
      .single();
      
    if (error || !data) return null;
    return { value: JSON.stringify(data.value) };
  }
};

const storage = SupabaseService;

const ThermaSnapsApp = () => {
  const [isAuthenticated, setIsAuthenticated] = useState(false);
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [currentScreen, setCurrentScreen] = useState('home');
  const [selectedLayout, setSelectedLayout] = useState(null);
  const [countdown, setCountdown] = useState(null);
  const [capturedImages, setCapturedImages] = useState([]);
  const [currentPhotoIndex, setCurrentPhotoIndex] = useState(0);
  const [qrCodes, setQrCodes] = useState({ png: '' });
  const [isPrinting, setIsPrinting] = useState(false);
  const [printerConnected, setPrinterConnected] = useState(false);
  const [showDownload, setShowDownload] = useState(false);
  const [downloadData, setDownloadData] = useState(null);
  const [printQuantity, setPrintQuantity] = useState(1);
  const [isCountingDown, setIsCountingDown] = useState(false);
  const [previewStep, setPreviewStep] = useState('review'); // 'review' | 'quantity'
  const [isCheckingDownload, setIsCheckingDownload] = useState(() => {
    return !!new URLSearchParams(window.location.search).get('download');
  });

  const decorativePositions = {
    el1: { top: '-50px', left: '-50px', transform: 'rotate(45deg) scale(1.5)' },
    el2: { bottom: '-50px', right: '-50px', transform: 'rotate(-45deg) scale(1.5)' }
  };
  
  const videoRef = useRef(null);
  const canvasRef = useRef(null);
  const streamRef = useRef(null);
  const printerRef = useRef(null);

  const setVideoRef = useCallback((node) => {
    videoRef.current = node;
    if (node && streamRef.current) {
      node.srcObject = streamRef.current;
      node.play().catch(e => console.log("Play error", e));
    }
  }, []);

  const handleLogin = () => {
    if (username === 'admin123' && password === '040404') {
      setIsAuthenticated(true);
    } else {
      alert('Invalid credentials');
    }
  };

  const connectPrinter = async () => {
    try {
      const printer = new ThermalPrinter();
      await printer.connect();
      printerRef.current = printer;
      setPrinterConnected(true);
      alert('MP-58A1 Printer connected!');
    } catch (error) {
      if (error.name !== 'NotFoundError') {
        console.error("Printer connection error:", error);
        alert('Failed to connect printer. Ensure it is on and not connected to another device.');
      }
    }
  };

  const createFramedImage = async (images, date) => {
    const canvas = document.createElement('canvas');
    const padding = 40;
    const headerHeight = 310;
    const imgHeight = selectedLayout === 1 ? 1000 : 500;
    const gap = 40;
    const footerHeight = 200;
    
    // Calculate dynamic height to remove extra whitespace
    const totalHeight = padding + headerHeight + (images.length * imgHeight) + ((images.length - 1) * gap) + footerHeight;
    
    canvas.width = 800;
    canvas.height = totalHeight;
    const ctx = canvas.getContext('2d');
    
    ctx.fillStyle = '#FFFFFF';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    
    ctx.fillStyle = '#000';
    ctx.font = 'bold 150px "Computer Says No", monospace';
    ctx.textAlign = 'center';
    ctx.fillText('Therma-Snaps', canvas.width / 2, padding + 100);
    
    ctx.font = '80px "Computer Says No", monospace';
    ctx.fillText('Warm Memories on Receipts', canvas.width / 2, padding + 170);

    ctx.font = '80px "Computer Says No", monospace';
    ctx.fillText(date, canvas.width / 2, padding + 250);
    
    let yPos = padding + 310;
    const imgWidth = canvas.width - (padding * 2);
    
    for (let i = 0; i < images.length; i++) {
      const img = new Image();
      await new Promise((resolve) => {
        img.onload = resolve;
        img.src = images[i];
      });
      
      // Calculate cropping to match object-fit: cover
      const sourceAspect = img.width / img.height;
      const targetAspect = imgWidth / imgHeight;
      
      let sx = 0, sy = 0, sWidth = img.width, sHeight = img.height;
      
      if (sourceAspect > targetAspect) {
        // Source is wider, crop sides
        sWidth = img.height * targetAspect;
        sx = (img.width - sWidth) / 2;
      } else {
        // Source is taller, crop top/bottom
        sHeight = img.width / targetAspect;
        sy = (img.height - sHeight) / 2;
      }
      
      ctx.drawImage(img, sx, sy, sWidth, sHeight, padding, yPos, imgWidth, imgHeight);
      
      if (i < images.length - 1) yPos += imgHeight + 40;
      else yPos += imgHeight;
    }
    
    yPos += 60;
    ctx.font = '80px "Computer Says No", monospace';
    ctx.fillText('***', canvas.width / 2, yPos);
    ctx.fillText('Thanks for the warm moments', canvas.width / 2, yPos + 70);
    
    return canvas.toDataURL('image/png');
  };

  const printReceipt = async () => {
    if (!printerRef.current) {
      alert('Please connect printer first');
      return;
    }

    setIsPrinting(true);
    try {
      const date = new Date().toLocaleDateString('en-US', { 
        month: '2-digit', 
        day: '2-digit', 
        year: '2-digit' 
      });
      
      const receiptImage = await createFramedImage(capturedImages, date, true);
      await printerRef.current.printImage(receiptImage);
      
      alert('Print successful!');
    } catch (error) {
      console.error('Print error:', error);
      alert('Print failed. Please try again.');
    } finally {
      setIsPrinting(false);
    }
  };

  const handleContinue = async () => {
    if (printerConnected && printerRef.current) {
      setIsPrinting(true);
      try {
        const date = new Date().toLocaleDateString('en-US', { 
          month: '2-digit', 
          day: '2-digit', 
          year: '2-digit' 
        });
        const receiptImage = await createFramedImage(capturedImages, date, true);
        
        for (let i = 0; i < printQuantity; i++) {
           await printerRef.current.printImage(receiptImage);
           await new Promise(r => setTimeout(r, 3000));
        }
      } catch (e) {
        console.error(e);
      } finally {
        setIsPrinting(false);
      }
    }
    setCurrentScreen('final');
  };

  const startCamera = async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ 
        video: { facingMode: 'user', width: 1920, height: 1080 } 
      });
      if (videoRef.current) {
        videoRef.current.srcObject = stream;
        streamRef.current = stream;
      }
    } catch (err) {
      console.error('Camera error:', err);
      alert('Unable to access camera');
    }
  };

  const stopCamera = () => {
    if (streamRef.current) {
      streamRef.current.getTracks().forEach(track => track.stop());
      streamRef.current = null;
    }
    if (videoRef.current) {
      videoRef.current.srcObject = null;
    }
  };

  const takePhoto = () => {
    if (canvasRef.current && videoRef.current) {
      const canvas = canvasRef.current;
      const video = videoRef.current;
      canvas.width = video.videoWidth;
      canvas.height = video.videoHeight;
      const ctx = canvas.getContext('2d');
      ctx.drawImage(video, 0, 0);
      return canvas.toDataURL('image/png');
    }
    return null;
  };

  useEffect(() => {
    let interval;
    if (isCountingDown && countdown > 0) {
      interval = setInterval(() => {
        setCountdown(prev => prev - 1);
      }, 1000);
    } else if (isCountingDown && countdown === 0) {
      setIsCountingDown(false);
      const photo = takePhoto();
      if (photo) {
        setCapturedImages(prev => [...prev, photo]);
      }
    }
    return () => clearInterval(interval);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isCountingDown, countdown]);

  useEffect(() => {
    if (currentScreen === 'camera') {
      if (capturedImages.length === 0 && !isCountingDown && countdown === null) {
        setCountdown(5);
        setIsCountingDown(true);
      } else if (capturedImages.length > 0 && capturedImages.length < selectedLayout) {
        setCurrentPhotoIndex(capturedImages.length);
        setTimeout(() => {
          setCountdown(5);
          setIsCountingDown(true);
        }, 1000);
      } else if (capturedImages.length === selectedLayout) {
        stopCamera();
        setCurrentScreen('preview');
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [capturedImages.length, currentScreen, selectedLayout]);

  const generateQRCodes = async () => {
    const timestamp = Date.now();
    const currentDate = new Date().toLocaleDateString('en-US', { 
      month: '2-digit', 
      day: '2-digit', 
      year: '2-digit' 
    });
    
    const pngData = await createFramedImage(capturedImages, currentDate, false);
    
    const expiryDate = new Date();
    expiryDate.setDate(expiryDate.getDate() + 3);
    
    try {
      await storage.set(`photo_png_${timestamp}`, JSON.stringify({
        image: pngData,
        date: currentDate,
        expiry: expiryDate.toISOString(),
        isGif: false
      }));

      // Only generate QR code if storage was successful
      const baseUrl = window.location.origin + window.location.pathname;
      const pngUrl = `${baseUrl}?download=png&id=${timestamp}`;
      
      setQrCodes({ 
        png: `https://api.qrserver.com/v1/create-qr-code/?size=300x300&data=${encodeURIComponent(pngUrl)}`
      });

    } catch (error) {
      console.error('Storage error:', error);
      alert("Failed to save photo. " + (error.message || "Check internet/Supabase config."));
    }
  };

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const downloadType = params.get('download');
    const downloadId = params.get('id');
    
    if (downloadType && downloadId) {
      loadDownloadPage(downloadType, downloadId);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const loadDownloadPage = async (type, id) => {
    try {
      const key = `photo_${type}_${id}`;
      const result = await storage.get(key);
      
      if (result) {
        const data = JSON.parse(result.value);
        
        if (new Date(data.expiry) < new Date()) {
          setDownloadData({ expired: true });
        } else {
          setDownloadData({ ...data, type });
        }
        setShowDownload(true);
      }
    } catch (error) {
      console.error('Failed to load photo:', error);
    } finally {
      setIsCheckingDownload(false);
    }
  };

  useEffect(() => {
    if (currentScreen === 'camera' && !streamRef.current) {
      startCamera();
    }
    return () => {
      if (currentScreen !== 'camera') {
        stopCamera();
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentScreen]);

  useEffect(() => {
    if (currentScreen === 'final') {
      generateQRCodes();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentScreen]);

  const containerStyle = {
    width: '768px',
    height: '1024px',
    margin: '0 auto',
    backgroundColor: '#3e000c',
    fontFamily: "'Space Mono', monospace",
    position: 'relative',
    overflow: 'hidden',
  };

  if (isCheckingDownload) {
    return (
      <div style={{
        width: '100vw',
        height: '100vh',
        backgroundColor: '#3e000c',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center'
      }}>
        <p style={{ fontFamily: "'Space Mono', monospace", color: '#ffecd1', fontSize: '24px' }}>Loading...</p>
      </div>
    );
  }

  if (showDownload && downloadData) {
    if (downloadData.expired) {
      return (
        <div style={{
          width: '100vw',
          height: '100vh',
          backgroundColor: '#3e000c',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          flexDirection: 'column',
          padding: '40px'
        }}>
          <h1 style={{
            fontFamily: "'Playfair Display', serif",
            fontSize: '48px',
            color: '#ffd482',
            marginBottom: '20px'
          }}>
            QR Code Expired
          </h1>
          <p style={{
            fontFamily: "'Space Mono', monospace",
            fontSize: '18px',
            color: '#ffecd1',
            textAlign: 'center'
          }}>
            This download link has expired after 3 days.<br/>
            Please take a new photo at Therma-Snaps!
          </p>
        </div>
      );
    }

    return (
      <div style={{
        width: '100vw',
        minHeight: '100vh',
        backgroundColor: '#3e000c',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        flexDirection: 'column', 
        padding: '40px'
      }}>
        <div style={{
          marginBottom: '40px',
          display: 'flex',
          alignItems: 'center',
          gap: '15px'
        }}>
          <div style={{
            width: '50px',
            height: '50px',
            clipPath: 'polygon(50% 0%, 61% 35%, 98% 35%, 68% 57%, 79% 91%, 50% 70%, 21% 91%, 32% 57%, 2% 35%, 39% 35%)',
            backgroundColor: '#9d2222'
          }} />
          <h1 style={{
            fontFamily: "'Farmhand Serif', serif",
            fontSize: '48px',
            color: '#ffd482'
          }}>
            DOWNLOAD
          </h1>
        </div>

        <div style={{
          maxWidth: '800px',
          backgroundColor: '#ffecd1',
          padding: '20px',
          boxShadow: '10px 10px 0 rgba(0,0,0,0.3)',
          display: 'flex',
          justifyContent: 'center'
        }}>
          <img 
            src={downloadData.image} 
            alt="Your Therma-Snap"
            style={{
              width: '400px',
              display: 'block'
            }}
          />
        </div>

        <button
          onClick={() => {
            const link = document.createElement('a');
            link.href = downloadData.image;
            link.download = `therma-snaps-${downloadData.date}.${downloadData.type}`;
            link.click();
          }}
          style={{
            marginTop: '40px',
            padding: '20px 60px',
            fontSize: '28px',
            fontFamily: "'Imbue', serif",
            fontStyle: 'italic',
            backgroundColor: '#ffd482',
            color: '#3e000c',
            border: 'none',
            cursor: 'pointer',
            fontWeight: '600'
          }}
        >
          Download {downloadData.type?.toUpperCase()}
        </button>

        <p style={{
          fontFamily: "'Space Mono', monospace",
          fontSize: '14px',
          color: '#ffd482',
          marginTop: '30px'
        }}>
          Expires: {new Date(downloadData.expiry).toLocaleDateString()}
        </p>
      </div>
    );
  }

  const params = new URLSearchParams(window.location.search);
  if (params.get('download') && !isAuthenticated) {
    return (
      <div style={{
        width: '100vw',
        height: '100vh',
        backgroundColor: '#3e000c',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        flexDirection: 'column',
        padding: '40px'
      }}>
        <h1 style={{
          fontFamily: "'Farmhand Serif', serif",
          fontSize: '48px',
          color: '#ffd482',
          marginBottom: '20px',
          textAlign: 'center'
        }}>
          Photo Not Found
        </h1>
        <p style={{
          fontFamily: "'Space Mono', monospace",
          fontSize: '18px',
          color: '#ffecd1',
          textAlign: 'center'
        }}>
          The photo you are looking for could not be found.<br/>
          It may have expired or was taken on a different device.
        </p>
        <button
          onClick={() => window.location.href = window.location.origin + window.location.pathname}
          style={{
            marginTop: '40px',
            padding: '15px 40px',
            fontSize: '24px',
            fontFamily: "'Space Mono', monospace",
            backgroundColor: '#9d2222',
            color: '#ffecd1',
            border: 'none',
            cursor: 'pointer'
          }}
        >
          Go to Home
        </button>
      </div>
    );
  }

  if (!isAuthenticated) {
    return (
      <div style={containerStyle}>
        <div style={{ 
          display: 'flex', 
          flexDirection: 'column', 
          alignItems: 'center', 
          justifyContent: 'center', 
          height: '100%',
          padding: '40px'
        }} className="fade-in">
          <img src={element2Img} alt="" style={{ position: 'absolute', top: '-50px', left: '-90px', width: '300px', opacity: 0.6, zIndex: 0, transform: 'rotate(90deg)' }} />
          <img src={element1Img} alt="" style={{ position: 'absolute', bottom: '50px', right: '50px', width: '300px', opacity: 0.6, zIndex: 0, transform: 'rotate(90deg)' }} />
          
          <img 
            src={logoImg} 
            alt="Therma-Snaps" 
            style={{ width: '400px', marginBottom: '40px', zIndex: 10 }} 
          />
          
          <p style={{
            fontFamily: "'Space Mono', monospace",
            fontSize: '16px',
            color: '#ffecd1',
            marginTop: '-100px',
            marginBottom: '60px',
            zIndex: 10
          }}>
            Admin Login
          </p>
          
          <div style={{
            display: 'flex',
            flexDirection: 'column',
            gap: '20px',
            width: '100%',
            maxWidth: '400px',
            zIndex: 10
          }}>
            <input
              type="text"
              placeholder="Username"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              onKeyPress={(e) => e.key === 'Enter' && handleLogin()}
              style={{
                padding: '15px',
                fontSize: '18px',
                fontFamily: "'Space Mono', monospace",
                backgroundColor: '#ffecd1',
                border: 'none',
                borderRadius: '0'
              }}
            />
            <input
              type="password"
              placeholder="Password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              onKeyPress={(e) => e.key === 'Enter' && handleLogin()}
              style={{
                padding: '15px',
                fontSize: '18px',
                fontFamily: "'Space Mono', monospace",
                backgroundColor: '#ffecd1',
                border: 'none',
                borderRadius: '0'
              }}
            />
            <button
              onClick={handleLogin}
              style={{
                padding: '20px',
                fontSize: '48px',
                fontFamily: "'Imbue', serif",
                backgroundColor: 'transparent',
                color: '#ffd482',
                border: 'none',
                cursor: 'pointer',
                marginTop: '20px',
              }}
            >
              LOGIN
            </button>
          </div>
        </div>
      </div>
    );
  }

  if (currentScreen === 'home') {
    return (
      <div style={containerStyle}>
        <img src={element2Img} alt="" style={{ position: 'absolute', bottom: '50px', right: '50px', width: '250px', opacity: 0.8, zIndex: 0 }} />
        
        <div style={{ 
          display: 'flex', 
          flexDirection: 'column', 
          alignItems: 'center', 
          justifyContent: 'flex-start', 
          height: '100%',
          padding: '100px 40px 40px 40px',
          position: 'relative',
          zIndex: 10
        }} className="fade-in">
          <div style={{
            position: 'absolute',
            top: '20px',
            right: '20px',
            display: 'flex',
            gap: '15px'
          }}>
            <button
              onClick={connectPrinter}
              style={{
                padding: '12px 20px',
                backgroundColor: printerConnected ? '#4CAF50' : '#9d2222',
                color: '#ffecd1',
                border: 'none',
                cursor: 'pointer',
                display: 'flex',
                alignItems: 'center',
                gap: '8px',
                fontFamily: "'Space Mono', monospace",
                fontSize: '14px'
              }}
            >
              {printerConnected ? <Wifi size={18} /> : <Printer size={18} />}
              {printerConnected ? 'Connected' : 'Connect Printer'}
            </button>
          </div>
          
          <img 
            src={logoImg} 
            alt="Therma-Snaps" 
            style={{ width: '650px', marginBottom: '10px', marginLeft: '-30px' }} 
          />
          
          <p style={{
            fontFamily: "'Space Mono', monospace",
            fontSize: '20px',
            color: '#ffecd1',
            position: 'absolute',
            top: '330px',
            width: '100%',
            textAlign: 'center',
            zIndex: 20,
            margin: 0
          }}>
            Warm Memories on Receipts
          </p>
          
          <img 
            src={homeHeroImg} 
            alt="Therma-Snaps Examples" 
            style={{ width: '450px', marginBottom: '-100px', marginTop: '-180px' }} 
          />
          
          <button
            onClick={() => setCurrentScreen('layout')}
            style={{
              padding: '20px',
              fontSize: '64px',
              fontFamily: "'Imbue', serif",
              backgroundColor: 'transparent',
              color: '#ffecd1',
              border: 'none',
              cursor: 'pointer',
            }}
          >
            START
          </button>
        </div>
      </div>
    );
  }

  if (currentScreen === 'layout') {
    return (
      <div style={containerStyle}>
        <img src={element1Img} alt="" style={{ position: 'absolute', width: '300px', opacity: 0.6, zIndex: 0, ...decorativePositions.el1 }} />
        <img src={element2Img} alt="" style={{ position: 'absolute', width: '300px', opacity: 0.6, zIndex: 0, ...decorativePositions.el2 }} />
        
        <div style={{ 
          display: 'flex', 
          flexDirection: 'column', 
          alignItems: 'center', 
          padding: '60px 40px',
          height: '100%',
          position: 'relative',
          zIndex: 10
        }} className="fade-in">
          <div style={{
            position: 'absolute',
            top: '60px',
            display: 'flex',
            alignItems: 'center',
            gap: '15px'
          }}>
             <img src={logoImg} alt="Therma-Snaps" style={{ width: '150px' }} />
          </div>
          
          <h2 style={{ 
            fontFamily: "'Farmhand Serif', serif",
            fontSize: '72px',
            color: '#ffd482',
            textAlign: 'center',
            marginTop: '140px',
            marginBottom: '100px',
            letterSpacing: '2px',
            fontWeight: '700'
          }}>
            CHOOSE LAYOUT
          </h2>
          
          <div style={{
            display: 'flex',
            gap: '60px',
            justifyContent: 'center'
          }}>
            <div
              onClick={() => {
                setSelectedLayout(1);
                setCapturedImages([]);
                setCurrentPhotoIndex(0);
                setCountdown(null);
                setPreviewStep('review');
                setCurrentScreen('camera');
              }}
              style={{
                width: '280px',
                height: '400px',
                backgroundColor: '#ffecd1',
                padding: '30px',
                cursor: 'pointer',
                transition: 'transform 0.2s',
                border: '5px solid transparent'
              }}
              onMouseEnter={(e) => e.currentTarget.style.transform = 'scale(1.05)'}
              onMouseLeave={(e) => e.currentTarget.style.transform = 'scale(1)'}
            >
              <div style={{
                width: '100%',
                height: '100%',
                backgroundColor: '#9d2222'
              }} />
            </div>
            
            <div
              onClick={() => {
                setSelectedLayout(2);
                setCapturedImages([]);
                setCurrentPhotoIndex(0);
                setCountdown(null);
                setPreviewStep('review');
                setCurrentScreen('camera');
              }}
              style={{
                width: '280px',
                height: '400px',
                backgroundColor: '#ffecd1',
                padding: '30px',
                cursor: 'pointer',
                transition: 'transform 0.2s',
                border: '5px solid transparent',
                display: 'flex',
                flexDirection: 'column',
                gap: '20px'
              }}
              onMouseEnter={(e) => e.currentTarget.style.transform = 'scale(1.05)'}
              onMouseLeave={(e) => e.currentTarget.style.transform = 'scale(1)'}
            >
              <div style={{
                flex: 1,
                backgroundColor: '#9d2222'
              }} />
              <div style={{
                flex: 1,
                backgroundColor: '#9d2222'
              }} />
            </div>
          </div>
        </div>
      </div>
    );
  }

  if (currentScreen === 'camera') {
    return (
      <div style={containerStyle}>
        <div style={{ 
          display: 'flex',
          flexDirection: 'column', 
          alignItems: 'center',
          justifyContent: 'center',
          height: '100%',
          padding: '0px',
          position: 'relative'
        }} className="fade-in">
          <div style={{
            width: '400px',
            backgroundColor: '#FFFFFF',
            padding: '40px',
            display: 'flex',
            flexDirection: 'column',
            boxShadow: '10px 10px 0 rgba(0,0,0,0.3)',
            alignItems: 'center'
          }}>
            <div style={{
              fontFamily: "'Computer Says No', monospace",
              fontSize: '42px',
              fontWeight: 'bold',
              marginBottom: '15px',
              textAlign: 'center'
            }}>
              Therma-Snaps<br/>
              <span style={{ fontSize: '28px' }}>Warm Memories on Receipts</span><br/>
              {new Date().toLocaleDateString('en-US', { 
                month: '2-digit', 
                day: '2-digit', 
                year: '2-digit' 
              })}
            </div>
            
            <div style={{
              display: 'flex',
              flexDirection: 'column',
              gap: selectedLayout === 2 ? '20px' : '0',
              width: '100%'
            }}>
              {Array.from({ length: selectedLayout }).map((_, idx) => (
                <div key={idx} style={{
                  width: '100%',
                  height: selectedLayout === 2 ? '270px' : '570px',
                  border: '3px solid #3e000c',
                  position: 'relative',
                  backgroundColor: '#ddd',
                  overflow: 'hidden'
                }}>
                  {capturedImages[idx] ? (
                    <img 
                      src={capturedImages[idx]} 
                      alt={`Capture ${idx + 1}`}
                      style={{
                        width: '100%',
                        height: '100%',
                        objectFit: 'cover'
                      }}
                    />
                  ) : idx === currentPhotoIndex && (
                    <>
                      <video
                        ref={setVideoRef}
                        autoPlay
                        playsInline
                        muted
                        style={{
                          width: '100%',
                          height: '100%',
                          objectFit: 'cover'
                        }}
                      />
                      {countdown !== null && (
                        <div style={{
                          position: 'absolute',
                          top: '50%',
                          left: '50%',
                          transform: 'translate(-50%, -50%)',
                          fontSize: '100px',
                          fontFamily: "'Farmhand Serif', serif",
                          color: '#ffd482',
                          textShadow: '0 0 10px rgba(0,0,0,0.8)',
                          fontWeight: 'bold',
                          zIndex: 20
                        }}>
                          {countdown}
                        </div>
                      )}
                    </>
                  )}
                </div>
              ))}
            </div>
            
            <div style={{
              fontFamily: "'Computer Says No', monospace",
              fontSize: '32px',
              textAlign: 'center',
              marginTop: '20px'
            }}>
              ***<br/>
              Thanks for the warm moments
            </div>
          </div>

          <canvas ref={canvasRef} style={{ display: 'none' }} />
          
          <div style={{
            marginTop: '20px',
            fontFamily: "'Space Mono', monospace",
            fontSize: '18px',
            color: '#ffecd1',
            backgroundColor: 'rgba(0,0,0,0.6)',
            padding: '15px 25px'
          }}>
            Photo {currentPhotoIndex + 1} of {selectedLayout}
          </div>
        </div>
      </div>
    );
  }

  if (currentScreen === 'preview') {
    return (
      <div style={containerStyle}>
        <div style={{ 
          display: 'flex', 
          flexDirection: 'column', 
          alignItems: 'center', 
          justifyContent: 'center',
          height: '100%',
          padding: '50px 0',
          position: 'relative'
        }} className="fade-in">
          
          {previewStep === 'review' ? (
            <h2 style={{
              fontFamily: "'Computer Says No', monospace",
              fontSize: '64px',
              color: '#ffd482',
              margin: '0 0 30px 0',
              textAlign: 'center',
              zIndex: 20
            }}>
              How'd you look?
            </h2>
          ) : (
            <h2 style={{
              fontFamily: "'Computer Says No', monospace",
              fontSize: '48px',
              color: '#ffd482',
              margin: '0 0 30px 0',
              textAlign: 'center',
              zIndex: 20
            }}>
              Choose how many prints
            </h2>
          )}

          <div style={{
            width: '340px',
            backgroundColor: '#FFFFFF',
            padding: '40px',
            display: 'flex',
            flexDirection: 'column',
            boxShadow: '10px 10px 0 rgba(0,0,0,0.3)'
          }}>
            <div style={{
              fontFamily: "'Computer Says No', monospace",
              fontSize: '36px',
              marginBottom: '20px',
              textAlign: 'center'
            }}>
              Therma-Snaps<br/>
              <span style={{ fontSize: '28px' }}>Warm Memories on Receipts</span><br/>
              {new Date().toLocaleDateString('en-US', { 
                month: '2-digit', 
                day: '2-digit', 
                year: '2-digit' 
              })}
            </div>
            
            <div style={{
              display: 'flex',
              flexDirection: 'column',
              gap: selectedLayout === 2 ? '20px' : '0'
            }}>
              {capturedImages.map((img, idx) => (
                <img
                  key={idx}
                  src={img}
                  alt={`Capture ${idx + 1}`}
                  style={{
                    width: '100%',
                    height: selectedLayout === 2 ? '230px' : '480px',
                    objectFit: 'cover',
                    border: '3px solid #3e000c'
                  }}
                />
              ))}
            </div>
            
            <div style={{
              fontFamily: "'Computer Says No', monospace",
              fontSize: '28px',
              textAlign: 'center',
              marginTop: '20px'
            }}>
              ***<br/>
              Thanks for the warm moments
            </div>
          </div>
          
          {previewStep === 'review' ? (
            <div style={{ marginTop: '40px' }}>
              <div style={{
                display: 'flex',
                gap: '40px',
                alignItems: 'center'
              }}>
                <button
                  onClick={() => {
                    setCapturedImages([]);
                    setCurrentPhotoIndex(0);
                    setCountdown(null);
                    setPreviewStep('review');
                    setCurrentScreen('camera');
                  }}
                  style={{
                    fontSize: '48px',
                    fontFamily: "'Computer Says No', monospace",
                    backgroundColor: 'transparent',
                    color: '#ffecd1',
                    border: 'none',
                    cursor: 'pointer'
                  }}
                >
                  Retake
                </button>
                
                <button
                  onClick={() => setPreviewStep('quantity')}
                  style={{
                    fontSize: '48px',
                    fontFamily: "'Computer Says No', monospace",
                    backgroundColor: 'transparent',
                    color: '#ffd482',
                    border: 'none',
                    cursor: 'pointer'
                  }}
                >
                  Continue
                </button>
              </div>
            </div>
          ) : (
            <div style={{ marginTop: '40px', display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
              <div style={{
                display: 'flex',
                alignItems: 'center',
                gap: '20px',
                marginBottom: '40px'
              }}>
                <button 
                  onClick={() => setPrintQuantity(Math.max(1, printQuantity - 1))}
                  style={{
                    width: '70px', height: '70px', borderRadius: '50%', fontSize: '32px', cursor: 'pointer',
                    backgroundColor: '#9d2222', color: '#ffecd1', border: 'none', display: 'flex', alignItems: 'center', justifyContent: 'center'
                  }}
                >-</button>
                <span style={{ fontSize: '48px', fontFamily: "'Space Mono', monospace", minWidth: '60px', textAlign: 'center', color: '#ffecd1' }}>{printQuantity}</span>
                <button 
                  onClick={() => setPrintQuantity(Math.min(5, printQuantity + 1))}
                  style={{
                    width: '70px', height: '70px', borderRadius: '50%', fontSize: '32px', cursor: 'pointer',
                    backgroundColor: '#9d2222', color: '#ffecd1', border: 'none', display: 'flex', alignItems: 'center', justifyContent: 'center'
                  }}
                >+</button>
              </div>
              
              <button
                onClick={handleContinue}
                style={{
                  fontSize: '64px',
                  fontFamily: "'Computer Says No', monospace",
                  backgroundColor: 'transparent',
                  color: '#ffd482',
                  border: 'none',
                  cursor: 'pointer'
                }}
              >
                {isPrinting ? 'Printing...' : 'Print'}
              </button>
            </div>
          )}
        </div>
      </div>
    );
  }

  if (currentScreen === 'final') {
    return (
      <div style={containerStyle}>
        <img src={element1Img} alt="" style={{ position: 'absolute', width: '300px', opacity: 0.6, zIndex: 0, ...decorativePositions.el1 }} />
        <img src={element2Img} alt="" style={{ position: 'absolute', width: '300px', opacity: 0.6, zIndex: 0, ...decorativePositions.el2 }} />
        
        <div style={{ 
          display: 'flex', 
          flexDirection: 'column', 
          alignItems: 'center', 
          padding: '60px 40px',
          height: '100%',
          position: 'relative',
          zIndex: 10
        }} className="fade-in">
          <div style={{
            position: 'absolute',
            top: '60px',
            display: 'flex',
            alignItems: 'center',
            gap: '15px'
          }}>
            <img src={logoImg} alt="Therma-Snaps" style={{ width: '150px' }} />
          </div>
          
          <h2 style={{ 
            fontFamily: "'Farmhand Serif', serif",
            fontSize: '64px',
            color: '#ffd482',
            textAlign: 'center',
            marginTop: '100px',
            marginBottom: '20px',
            letterSpacing: '2px',
            fontWeight: '700'
          }}>
            COME AGAIN
          </h2>
          
          <p style={{
            fontFamily: "'Space Mono', monospace",
            fontSize: '18px',
            color: '#ffecd1',
            marginBottom: '40px',
            textAlign: 'center'
          }}>
            Scan this QR code to save<br/>your moment digitally
          </p>
          
          <div style={{
            display: 'flex',
            gap: '60px',
            justifyContent: 'center',
            marginBottom: '30px'
          }}>
            <div style={{
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              gap: '15px'
            }}>
              <div style={{
                width: '200px',
                height: '200px',
                backgroundColor: '#ffecd1',
                padding: '15px',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center'
              }}>
                {qrCodes.png ? (
                  <img src={qrCodes.png} alt="PNG QR" style={{ width: '100%', height: '100%' }} />
                ) : (
                  <div style={{ fontSize: '14px' }}>Generating...</div>
                )}
              </div>
              <span style={{
                fontFamily: "'Farmhand Serif', serif",
                fontSize: '28px',
                color: '#ffecd1',
                fontWeight: 'bold'
              }}>
                PNG
              </span>
            </div>
            
          </div>
          
          <p style={{
            fontFamily: "'Space Mono', monospace",
            fontSize: '14px',
            color: '#ffd482',
            marginBottom: '25px',
            textAlign: 'center'
          }}>
            ⚠ Scan within 3 days before QR codes expire
          </p>
          
          <div style={{
            display: 'flex',
            gap: '20px'
          }}>
            {printerConnected && (
              <button
                onClick={printReceipt}
                disabled={isPrinting}
                style={{
                  padding: '15px 40px',
                  fontSize: '20px',
                  fontFamily: "'Space Mono', monospace",
                  backgroundColor: isPrinting ? '#666' : '#4CAF50',
                  color: '#ffecd1',
                  border: 'none',
                  cursor: isPrinting ? 'not-allowed' : 'pointer',
                  display: 'flex',
                  alignItems: 'center',
                  gap: '10px'
                }}
              >
                <Printer size={20} />
                {isPrinting ? 'Printing...' : 'Print Receipt'}
              </button>
            )}
            
            <button
              onClick={() => {
                setCapturedImages([]);
                setSelectedLayout(null);
                setCountdown(null);
                setPreviewStep('review');
                setCurrentScreen('home');
              }}
              style={{
                padding: '15px 40px',
                fontSize: '20px',
                fontFamily: "'Space Mono', monospace",
                backgroundColor: '#9d2222',
                color: '#ffecd1',
                border: 'none',
                cursor: 'pointer'
              }}
            >
              Back to Home
            </button>
          </div>
        </div>
      </div>
    );
  }

  return null;
};

export default ThermaSnapsApp