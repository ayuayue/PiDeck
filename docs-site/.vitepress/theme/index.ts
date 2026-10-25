import DefaultTheme from "vitepress/theme";
import CopyText from "./CopyText.vue";
import "./custom.css";

export default {
  extends: DefaultTheme,
  enhanceApp({ app }) {
    app.component("CopyText", CopyText);
  },
};
