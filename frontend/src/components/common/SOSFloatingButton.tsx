import { useNavigate } from 'react-router-dom';

export default function SOSFloatingButton() {
  const navigate = useNavigate();
  return (
    <button
      onClick={() => navigate('/sos')}
      className="btn3d btn3d-danger fixed bottom-20 right-4 z-50 w-12 h-12 rounded-full bg-danger shadow-lg shadow-red-900/50 flex items-center justify-center text-ink font-black text-sm active:scale-95 transition-transform"
      aria-label="SOS Emergency"
    >SOS
    </button>
  );
}
