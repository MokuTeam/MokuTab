import { createApp } from 'vue';
import { NativeMessageType } from '@mokuhub/mokutab-shared';
import './style.css';
import App from './App.vue';

// Trigger ensure native connection (fire-and-forget, don't block UI mounting)
void chrome.runtime.sendMessage({ type: NativeMessageType.ENSURE_NATIVE }).catch(() => {
  // Silent failure - background will handle reconnection
});
createApp(App).mount('#app');
