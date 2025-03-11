import { useState, useEffect } from "react";
import { getMagicCodes } from "../services/api";
import { MagicCode } from "../types";

const MagicCodeList: React.FC = () => {
  const [codes, setCodes] = useState<MagicCode[]>([]);
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const fetchCodes = async () => {
      try {
        const data = await getMagicCodes();
        setCodes(data);
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

  if (loading) return <div className="loading">Loading magic codes...</div>;
  if (error) return <div className="error">{error}</div>;

  return (
    <div className="magic-code-list">
      <h2>Recent Magic Codes</h2>
      {codes.length === 0 ? (
        <p>No magic codes found yet. Sign in to websites to see them appear here.</p>
      ) : (
        <div className="codes-container">
          {codes.map((code) => (
            <div key={code.id} className="code-card">
              <div className="code-website">{code.website}</div>
              <div className="code-value">{code.code}</div>
              <div className="code-time">{formatDate(code.created_at)}</div>
              <button
                className="copy-btn"
                onClick={() => navigator.clipboard.writeText(code.code)}
              >
                Copy
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
};

export default MagicCodeList;