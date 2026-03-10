import { createApp } from 'vue';
import ElementPlus from 'element-plus';
import 'element-plus/dist/index.css';

import App from './App.vue';
import router from './router';
import { useAuthSession } from './stores/authSession';
import './style.css';

(async () => {
  try {
    await useAuthSession().initializeAuthSession();
  } catch (error) {
    console.error('Failed to initialize auth session:', error);
  }
  
  createApp(App).use(ElementPlus).use(router).mount('#app');
})();
