import { mount, unmount } from "svelte";
import App from "./svelte.svelte";
let app;
window.clientMount = () => { app = mount(App, { target: document.getElementById("mount") }); };
window.clientDetach = () => unmount(app);
