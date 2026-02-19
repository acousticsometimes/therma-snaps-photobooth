// MP-58A1 Thermal Printer Integration
export class ThermalPrinter {
  constructor() {
    this.device = null;
    this.characteristic = null;
  }

  async connect() {
    try {
      // Request Bluetooth device (MP-58A1 uses standard Bluetooth printer profile)
      this.device = await navigator.bluetooth.requestDevice({
        filters: [
          { services: ['000018f0-0000-1000-8000-00805f9b34fb'] }
        ],
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
    if (!this.characteristic) {
      throw new Error('Printer not connected');
    }

    const img = new Image();
    await new Promise((resolve, reject) => {
      img.onload = resolve;
      img.onerror = reject;
      img.src = imageDataUrl;
    });

    // Create canvas for image processing
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d');
    
    // MP-58A1 prints 58mm width = 384 pixels at 203dpi
    const printerWidth = 384;
    const aspectRatio = img.height / img.width;
    canvas.width = printerWidth;
    canvas.height = Math.floor(printerWidth * aspectRatio);

    // Draw white background
    ctx.fillStyle = '#FFFFFF';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    
    // Draw image
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);

    // Convert to thermal printer format
    const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
    const thermalData = this.convertToESCPOS(imageData);

    // Send to printer in chunks
    const chunkSize = 512;
    for (let i = 0; i < thermalData.length; i += chunkSize) {
      const chunk = thermalData.slice(i, i + chunkSize);
      await this.characteristic.writeValue(chunk);
      await new Promise(resolve => setTimeout(resolve, 50)); // Small delay between chunks
    }
  }

  convertToESCPOS(imageData) {
    const { width, height, data } = imageData;
    const commands = [];

    // Initialize printer
    commands.push(0x1B, 0x40); // ESC @ - Initialize
    commands.push(0x1B, 0x61, 0x01); // ESC a 1 - Center align

    // Process image in bands of 24 pixels (3 bytes)
    for (let y = 0; y < height; y += 24) {
      // Set bit image mode (ESC * m nL nH)
      commands.push(0x1B, 0x2A, 33); // 33 = 24-dot double-density
      commands.push(width & 0xFF, (width >> 8) & 0xFF); // Width in little-endian

      // Process each column
      for (let x = 0; x < width; x++) {
        // Process 3 bytes (24 pixels) vertically
        for (let k = 0; k < 3; k++) {
          let byte = 0;
          for (let b = 0; b < 8; b++) {
            const py = y + k * 8 + b;
            if (py < height) {
              const offset = (py * width + x) * 4;
              // Convert to grayscale
              const gray = data[offset] * 0.3 + data[offset + 1] * 0.59 + data[offset + 2] * 0.11;
              // Threshold to black/white
              if (gray < 128) {
                byte |= (1 << (7 - b));
              }
            }
          }
          commands.push(byte);
        }
      }
      commands.push(0x0A); // Line feed
    }

    // Feed paper and cut
    commands.push(0x1B, 0x64, 0x05); // ESC d 5 - Feed 5 lines
    commands.push(0x1D, 0x56, 0x01); // GS V 1 - Partial cut

    return new Uint8Array(commands);
  }

  disconnect() {
    if (this.device && this.device.gatt.connected) {
      this.device.gatt.disconnect();
    }
  }
}