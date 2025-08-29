// utils/log-hygiene.js
// Preload once at process start to enable console redaction globally.
import { installConsoleRedaction } from "./redact.js";
installConsoleRedaction();
