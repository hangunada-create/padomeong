// 파도멍: 홈 화면에 둘 수 있게 하는 최소한의 서비스 워커. 아무것도 저장하지 않고 늘 서버에서 새로 받는다.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', e => e.waitUntil(self.clients.claim()));
self.addEventListener('fetch', () => {});
