import { render } from 'preact';
import { App } from './App';
import './styles/app.css';

interface LaunchParams {
  files: { getFile(): Promise<File> }[];
}

// PWA 檔案關聯：雙擊 .olt 時，瀏覽器透過 launchQueue 把檔案交給我們
const launchFile = new Promise<File | null>((resolve) => {
  const lq = (window as unknown as { launchQueue?: { setConsumer(cb: (p: LaunchParams) => void): void } }).launchQueue;
  if (!lq) return resolve(null);
  lq.setConsumer(async (params) => {
    resolve(params.files.length ? await params.files[0].getFile() : null);
  });
  setTimeout(() => resolve(null), 3000);
});

render(<App launchFile={launchFile} />, document.getElementById('app')!);

if ('serviceWorker' in navigator && import.meta.env.PROD && location.protocol === 'https:') {
  window.addEventListener('load', () => navigator.serviceWorker.register('./sw.js').catch(() => {}));
}
