import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import { desktop } from './desktop/bridge';
import '@fontsource-variable/geist';
import '@fontsource-variable/geist-mono';
import './styles.css';

// Desktop app (Electron): title bar, cursors and selection behave like a Windows app (styles.css).
if (desktop) {
  const root = document.documentElement;
  root.classList.add('desktop');
  // Like native title bars, the top bar dims while the window is in the background.
  const setActive = () => root.classList.toggle('window-inactive', !document.hasFocus());
  window.addEventListener('focus', setActive);
  window.addEventListener('blur', setActive);
  setActive();
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
