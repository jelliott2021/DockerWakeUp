"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
var fs_1 = require("fs");
var path_1 = require("path");
var configPath = path_1.default.resolve(__dirname, "../config.json");
var outputDir = path_1.default.resolve(__dirname, "./confs");
var targetDir = "/etc/nginx/sites-enabled";
if (!fs_1.default.existsSync(configPath)) {
    console.error("config.json not found.");
    process.exit(1);
}
var config = JSON.parse(fs_1.default.readFileSync(configPath, "utf8"));
var domain = config.domain || "boozebrawl.com";
if (!fs_1.default.existsSync(outputDir)) {
    fs_1.default.mkdirSync(outputDir, { recursive: true });
}
// Create NGINX config files for each service
for (var _i = 0, _a = config.services; _i < _a.length; _i++) {
    var route = _a[_i].route;
    var fullDomain = "".concat(route, ".").concat(domain);
    var nginxConf = "\nserver {\n    listen 80;\n    server_name ".concat(fullDomain, ";\n    return 301 https://$host$request_uri;\n}\n\nserver {\n    listen 443 ssl;\n    server_name ").concat(fullDomain, ";\n\n    ssl_certificate /etc/letsencrypt/live/").concat(domain, "/fullchain.pem;\n    ssl_certificate_key /etc/letsencrypt/live/").concat(domain, "/privkey.pem;\n    include /etc/letsencrypt/options-ssl-nginx.conf;\n    ssl_dhparam /etc/letsencrypt/ssl-dhparams.pem;\n\n    location / {\n        proxy_pass http://127.0.0.1:8080/proxy/").concat(route, "/;\n        proxy_set_header Host $host;\n        proxy_set_header X-Real-IP $remote_addr;\n        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;\n        proxy_set_header X-Forwarded-Proto $scheme;\n        proxy_set_header Upgrade $http_upgrade;\n        proxy_set_header Connection \"upgrade\";\n        proxy_http_version 1.1;\n        proxy_buffering off;\n        proxy_request_buffering off;\n    }\n}").trim();
    var outputPath = path_1.default.join(outputDir, "".concat(route, ".conf"));
    fs_1.default.writeFileSync(outputPath, nginxConf + "\n");
    console.log("Generated: ".concat(outputPath));
}
// Safely create symlinks in /etc/nginx/sites-enabled
fs_1.default.readdirSync(outputDir).forEach(function (file) {
    if (file.endsWith(".conf")) {
        var src = path_1.default.join(outputDir, file);
        var dest = path_1.default.join(targetDir, file);
        try {
            if (fs_1.default.existsSync(dest)) {
                var stat = fs_1.default.lstatSync(dest);
                if (stat.isSymbolicLink()) {
                    var existingTarget = fs_1.default.readlinkSync(dest);
                    if (existingTarget === src) {
                        return; // Correct symlink already exists
                    }
                    else {
                        fs_1.default.unlinkSync(dest); // Wrong symlink, remove it
                    }
                }
                else {
                    fs_1.default.unlinkSync(dest); // Regular file, remove it
                }
            }
            fs_1.default.symlinkSync(src, dest);
            console.log("Symlinked: ".concat(dest, " \u2192 ").concat(src));
        }
        catch (e) {
            console.error("Failed to link ".concat(file, ":"), e);
        }
    }
});
