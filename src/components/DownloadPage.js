import React, { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';

const DownloadPage = () => {
  const { type, id } = useParams();
  const [photoData, setPhotoData] = useState(null);
  const [expired, setExpired] = useState(false);

  useEffect(() => {
    loadPhoto();
  }, [type, id]);

  const loadPhoto = async () => {
    try {
      const key = `photo_${type}_${id}`;
      const result = await window.storage.get(key);
      
      if (result) {
        const data = JSON.parse(result.value);
        
        // Check expiry
        if (new Date(data.expiry) < new Date()) {
          setExpired(true);
          return;
        }
        
        setPhotoData(data);
      }
    } catch (error) {
      console.error('Failed to load photo:', error);
    }
  };

  const downloadImage = () => {
    if (!photoData) return;
    
    const link = document.createElement('a');
    link.href = photoData.image;
    link.download = `therma-snaps-${photoData.date}.${type}`;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  };

  if (expired) {
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

  if (!photoData) {
    return (
      <div style={{
        width: '100vw',
        height: '100vh',
        backgroundColor: '#3e000c',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center'
      }}>
        <p style={{
          fontFamily: "'Space Mono', monospace",
          fontSize: '18px',
          color: '#ffecd1'
        }}>
          Loading...
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
          fontFamily: "'Playfair Display', serif",
          fontSize: '48px',
          color: '#ffd482'
        }}>
          THERMA-SNAPS
        </h1>
      </div>

      <div style={{
        maxWidth: '800px',
        backgroundColor: '#ffecd1',
        padding: '40px',
        boxShadow: '10px 10px 0 rgba(0,0,0,0.3)'
      }}>
        <img 
          src={photoData.image} 
          alt="Your Therma-Snap"
          style={{
            width: '100%',
            display: 'block'
          }}
        />
      </div>

      <button
        onClick={downloadImage}
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
        Download {type.toUpperCase()}
      </button>

      <p style={{
        fontFamily: "'Space Mono', monospace",
        fontSize: '14px',
        color: '#ffd482',
        marginTop: '30px',
        textAlign: 'center'
      }}>
        Expires: {new Date(photoData.expiry).toLocaleDateString()}
      </p>
    </div>
  );
};

export default DownloadPage;