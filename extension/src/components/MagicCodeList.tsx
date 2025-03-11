import { useState, useEffect } from "react";
import { getMagicCodes, copyToClipboard } from "../services/api";
import { MagicCode } from "../types";

const MagicCodeList: React.FC = () => {
  const [codes, setCodes] = useState<MagicCode[]>([]);
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);
  const [lastCodeId, setLastCodeId] = useState<number | null>(null);
  const [lastCodeTimestamp, setLastCodeTimestamp] = useState<number | null>(null);

  useEffect(() => {
    // Load the last code ID and timestamp from storage
    chrome.storage.local.get(['lastCodeId', 'lastCodeTimestamp'], (data) => {
      if (data.lastCodeId) setLastCodeId(data.lastCodeId);
      if (data.lastCodeTimestamp) setLastCodeTimestamp(data.lastCodeTimestamp);
    });

    const fetchCodes = async () => {
      try {
        const data = await getMagicCodes();
        setCodes(data.sort((a, b) => b.id - a.id)); // Sort by newest first
        setLoading(false);
      } catch (err) {
        setError("Failed to load magic codes");
        setLoading(false);
      }
    };

    fetchCodes();

    // Poll for new codes every 5 seconds
    const interval = setInterval(fetchCodes, 5000);
    return () => clearInterval(interval);
  }, []);

  const formatDate = (timestamp: number): string => {
    return new Date(timestamp * 1000).toLocaleString();
  };

  const handleCopyClick = async (code: string) => {
    await copyToClipboard(code);
  };

  // Check if a code is fresh (less than 5 minutes old)
  const isFresh = (id: number): boolean => {
    if (!lastCodeId || !lastCodeTimestamp) return false;
    if (id !== lastCodeId) return false;
    
    const now = Date.now();
    const fiveMinutesMs = 5 * 60 * 1000;
    return (now - lastCodeTimestamp) < fiveMinutesMs;
  };

  if (loading) return <div className="loading">Loading magic codes...</div>;
  if (error) return <div className="error">{error}</div>;

  return (
    <div className="magic-code-list">
      <h3>Recent Magic Codes</h3>
      {codes.length === 0 ? (
        <p className="no-codes">No magic codes found yet. Sign in to websites to see them appear here.</p>
      ) : (
        <div className="code-list">
          {codes.map((code) => (
            <div 
              key={code.id} 
              className={`code-row ${isFresh(code.id) ? 'fresh' : ''}`}
            >
              <div className="code-header">
                <div className="code-website">{code.website}</div>
                <div className="code-time">{formatDate(code.created_at)}</div>
              </div>
              <div className="code-body">
                <div className="code-value">{code.code}</div>
                <button
                  className="copy-btn"
                  onClick={() => handleCopyClick(code.code)}
                  title="Copy to clipboard"
                >
                  Copy
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
};

export default MagicCodeList;