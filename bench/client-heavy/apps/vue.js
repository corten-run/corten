import { createApp } from "vue";
import App from "./vue.vue";
const app = createApp(App);
window.clientMount = () => app.mount(document.getElementById("mount"));
window.clientDetach = () => app.unmount();
