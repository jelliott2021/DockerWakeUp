import fs from "fs";
import path from "path";
import { type ServiceConfig } from "../src/config";
import { type GeneratorContext, type RunCommand } from "../src/context";
import { STANDARD_SITES_DIR, generateNginx, renderNginxConf, shellQuote } from "../src/nginx";
import {
  captureConsole,
  makeTempDir,
  read,
  removeTempDir,
  settingsFor,
  writeFile,
  type ConsoleCapture,
  type TestConfig,
} from "./helpers";

const services: ServiceConfig[] = [
  { route: "jellyfin", target: "http://localhost:8096" },
  { route: "photos", target: "http://localhost:2283", domains: ["photos.example.org"] },
];
const config: TestConfig = { domain: "example.com", services };

/**
 * Makes /etc/nginx/sites-enabled look like an existing, empty directory that
 * is or isn't writable — without touching /etc. Every other path goes to the
 * real fs.
 */
function fakeStandardSitesDir(writable: boolean): void {
  const isStandard = (p: fs.PathLike) => String(p) === STANDARD_SITES_DIR;
  const inStandard = (p: fs.PathLike) => String(p).startsWith(STANDARD_SITES_DIR + path.sep);

  const realExists = fs.existsSync;
  jest
    .spyOn(fs, "existsSync")
    .mockImplementation((p) => (isStandard(p) ? true : inStandard(p) ? false : realExists(p)));

  const realAccess = fs.accessSync;
  jest.spyOn(fs, "accessSync").mockImplementation((p, mode) => {
    if (!isStandard(p)) return realAccess(p, mode);
    if (!writable) throw new Error("EACCES: permission denied");
  });

  const realReaddir = fs.readdirSync as unknown as (p: fs.PathLike, o?: unknown) => unknown;
  jest
    .spyOn(fs, "readdirSync")
    .mockImplementation(((p: fs.PathLike, o?: unknown) =>
      isStandard(p) ? [] : realReaddir(p, o)) as unknown as typeof fs.readdirSync);
}

describe("shellQuote", () => {
  it("wraps the value in single quotes", () => {
    expect(shellQuote("/etc/nginx/sites-enabled/a b.conf")).toBe(
      "'/etc/nginx/sites-enabled/a b.conf'",
    );
  });

  it("escapes embedded single quotes", () => {
    expect(shellQuote("it's here")).toBe("'it'\\''s here'");
  });
});

describe("renderNginxConf", () => {
  it("renders the vhost with an empty custom region", () => {
    expect(renderNginxConf(["jellyfin.example.com", "tv.example.org"], 9090, [])).toBe(
      [
        "server {",
        "    listen 80;",
        "    server_name jellyfin.example.com tv.example.org;",
        "",
        "    location / {",
        "        # custom-start (lines between these markers survive regeneration)",
        "        # custom-end",
        "",
        "        # The wake proxy routes by hostname — pass the request through untouched",
        "        proxy_pass http://127.0.0.1:9090;",
        "        proxy_set_header Host $host;",
        "        proxy_set_header X-Forwarded-Host $host;",
        "        proxy_set_header X-Real-IP $remote_addr;",
        "        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;",
        "        # https on purpose: TLS is terminated in front of this vhost (443",
        "        # server block or a tunnel), and apps should generate https URLs",
        "        proxy_set_header X-Forwarded-Proto https;",
        "        proxy_http_version 1.1;",
        "        # WebSocket support: pass the upgrade handshake through to the wake proxy",
        "        proxy_set_header Upgrade $http_upgrade;",
        "        proxy_set_header Connection $http_connection;",
        "        proxy_read_timeout 3600s;",
        "        proxy_buffering off;",
        "        proxy_request_buffering off;",
        "    }",
        "}",
        "",
      ].join("\n"),
    );
  });

  it("places the custom lines between the markers", () => {
    const text = renderNginxConf(["a.example.com"], 8080, ['        auth_basic "Restricted";', ""]);
    expect(text).toContain(
      "        # custom-start (lines between these markers survive regeneration)\n" +
        '        auth_basic "Restricted";\n' +
        "\n" +
        "        # custom-end\n",
    );
  });
});

describe("generateNginx", () => {
  let root: string;
  let generatorDir: string;
  let confsDir: string;
  let sitesDir: string;
  let runCommand: jest.MockedFunction<RunCommand>;
  let out: ConsoleCapture;

  beforeEach(() => {
    root = makeTempDir();
    generatorDir = path.join(root, "proxy-generator");
    confsDir = path.join(generatorDir, "confs");
    sitesDir = path.join(root, "sites");
    fs.mkdirSync(generatorDir);
    fs.mkdirSync(sitesDir);
    runCommand = jest.fn();
    out = captureConsole();
  });
  afterEach(() => removeTempDir(root));

  /** Runs the generator against the temp tree; NGINX_SITES_DIR is the temp sites dir unless overridden. */
  const run = (ctx: Partial<GeneratorContext> = {}, cfg = config) =>
    generateNginx(settingsFor(cfg), {
      generatorDir,
      env: { NGINX_SITES_DIR: sitesDir },
      runCommand,
      isRoot: false,
      ...ctx,
    });
  const commands = () => runCommand.mock.calls.map(([command]) => command);
  const conf = (name: string) => path.join(confsDir, `${name}.conf`);
  const link = (name: string) => path.join(sitesDir, `${name}.conf`);
  const ln = (name: string, sudo = "") => `${sudo}ln -s -- '${conf(name)}' '${link(name)}'`;
  const rm = (dest: string, sudo = "") => `${sudo}rm -- '${dest}'`;
  const generated = (name: string) => `Generated: ${conf(name)}`;
  const symlinked = (name: string) => `Symlinked: ${link(name)} → ${conf(name)}`;
  const footer = () =>
    `\nSymlinked into ${sitesDir} (custom NGINX_SITES_DIR) — reload NGINX yourself.`;

  it("writes one conf per HTTP service, links them and leaves the reload to the user", () => {
    expect(run()).toBe(0);
    expect(read(conf("jellyfin"))).toBe(renderNginxConf(["jellyfin.example.com"], 8080, []));
    expect(read(conf("photos"))).toBe(
      renderNginxConf(["photos.example.com", "photos.example.org"], 8080, []),
    );
    expect(commands()).toEqual([ln("jellyfin"), ln("photos")]);
    expect(runCommand).toHaveBeenCalledWith(ln("jellyfin")); // no stdio option for ln/rm
    expect(out.log).toEqual([
      generated("jellyfin"),
      generated("photos"),
      symlinked("jellyfin"),
      symlinked("photos"),
      footer(),
    ]);
    expect(out.warn).toEqual([]);
    expect(out.error).toEqual([]);
  });

  it("points the vhosts at the configured proxy port", () => {
    run({}, { ...config, proxyPort: 9090 });
    expect(read(conf("jellyfin"))).toContain("proxy_pass http://127.0.0.1:9090;");
  });

  it("writes no conf for tcp services", () => {
    run({}, { ...config, services: [...services, { route: "mc", target: "x:1", type: "tcp" }] });
    expect(fs.existsSync(conf("mc"))).toBe(false);
    expect(commands()).toEqual([ln("jellyfin"), ln("photos")]);
  });

  it("keeps a conf carrying the manual marker but still links it", () => {
    writeFile(conf("photos"), "# wakeup:manual\nserver { listen 80; }\n");
    expect(run()).toBe(0);
    expect(read(conf("photos"))).toBe("# wakeup:manual\nserver { listen 80; }\n");
    expect(out.log).toEqual([
      generated("jellyfin"),
      `Kept as-is (# wakeup:manual): ${conf("photos")}`,
      symlinked("jellyfin"),
      symlinked("photos"),
      footer(),
    ]);
  });

  it("carries the custom region over into the regenerated conf", () => {
    const custom = [
      '        auth_basic "Restricted";',
      "        auth_basic_user_file /x/.htpasswd;",
    ];
    writeFile(conf("jellyfin"), renderNginxConf(["stale.example.com"], 1234, custom));
    run();
    expect(out.log[0]).toBe("Preserving 2 custom line(s) in jellyfin.conf");
    expect(read(conf("jellyfin"))).toBe(renderNginxConf(["jellyfin.example.com"], 8080, custom));
  });

  it("migrates nginx-generator/confs on the first run, skipping example.conf", () => {
    const legacy = path.join(root, "nginx-generator", "confs");
    writeFile(
      path.join(legacy, "jellyfin.conf"),
      renderNginxConf(["jellyfin.example.com"], 8080, ["        allow 10.0.0.0/8;"]),
    );
    writeFile(path.join(legacy, "old.conf"), "server { server_name old.example.com; }\n");
    writeFile(path.join(legacy, "example.conf"), "# documentation only\n");
    writeFile(path.join(legacy, ".htpasswd"), "bob:hash\n");

    expect(run()).toBe(0);
    expect(fs.readdirSync(confsDir).sort()).toEqual([
      ".htpasswd",
      "jellyfin.conf",
      "old.conf",
      "photos.conf",
    ]);
    expect(read(path.join(confsDir, ".htpasswd"))).toBe("bob:hash\n");
    expect(read(conf("old"))).toBe("server { server_name old.example.com; }\n");
    expect(read(conf("jellyfin"))).toContain("        allow 10.0.0.0/8;\n");
    expect(out.log).toEqual([
      "Migrated from nginx-generator/confs: .htpasswd",
      "Migrated from nginx-generator/confs: jellyfin.conf",
      "Migrated from nginx-generator/confs: old.conf",
      "Preserving 1 custom line(s) in jellyfin.conf",
      generated("jellyfin"),
      generated("photos"),
      symlinked("jellyfin"),
      symlinked("old"),
      symlinked("photos"),
      footer(),
    ]);
  });

  it("also migrates when confs/ holds nothing but example.conf", () => {
    writeFile(conf("example"), "# documentation only\n");
    writeFile(path.join(root, "nginx-generator", "confs", "old.conf"), "old\n");
    run();
    expect(read(conf("old"))).toBe("old\n");
    expect(out.log[0]).toBe("Migrated from nginx-generator/confs: old.conf");
    expect(commands()).toEqual([ln("jellyfin"), ln("old"), ln("photos")]); // never example.conf
  });

  it("does not migrate once confs/ has a real conf", () => {
    writeFile(conf("existing"), "server {}\n");
    writeFile(path.join(root, "nginx-generator", "confs", "old.conf"), "old\n");
    run();
    expect(fs.existsSync(conf("old"))).toBe(false);
    expect(out.log.filter((line) => line.startsWith("Migrated"))).toEqual([]);
  });

  it("warns and stops after writing the confs when the sites directory is missing", () => {
    const missing = path.join(root, "missing");
    expect(run({ env: { NGINX_SITES_DIR: missing } })).toBe(0);
    expect(out.warn).toEqual([
      `${missing} not found — skipping symlink installation and NGINX reload.`,
      `Copy the generated confs from ${confsDir} into your NGINX setup manually.`,
    ]);
    expect(out.log).toEqual([generated("jellyfin"), generated("photos")]);
    expect(runCommand).not.toHaveBeenCalled();
    expect(fs.existsSync(conf("jellyfin"))).toBe(true);
  });

  it("removes broken symlinks from the sites directory and leaves the rest alone", () => {
    const stale = path.join(sitesDir, "stale.conf");
    fs.symlinkSync(path.join(root, "gone.conf"), stale);
    writeFile(path.join(root, "keep.conf"), "keep\n");
    fs.symlinkSync(path.join(root, "keep.conf"), path.join(sitesDir, "fine.conf"));
    writeFile(path.join(sitesDir, "plain.conf"), "plain\n");

    expect(run()).toBe(0);
    expect(commands()).toEqual([rm(stale), ln("jellyfin"), ln("photos")]);
    expect(out.log[0]).toBe(`Removed broken symlink: ${stale}`);
  });

  it("ignores entries it cannot inspect while cleaning up", () => {
    const stale = path.join(sitesDir, "stale.conf");
    fs.symlinkSync(path.join(root, "gone.conf"), stale);
    jest.spyOn(fs, "lstatSync").mockImplementationOnce(() => {
      throw new Error("EACCES");
    });
    expect(run()).toBe(0);
    expect(commands()).toEqual([ln("jellyfin"), ln("photos")]);
    expect(out.log).not.toContain(`Removed broken symlink: ${stale}`);
  });

  it("leaves a correct symlink alone", () => {
    writeFile(conf("jellyfin"), "placeholder\n"); // so the link target exists during cleanup
    fs.symlinkSync(conf("jellyfin"), link("jellyfin"));
    expect(run()).toBe(0);
    expect(commands()).toEqual([ln("photos")]);
    expect(out.log).toEqual([
      generated("jellyfin"),
      generated("photos"),
      symlinked("photos"),
      footer(),
    ]);
  });

  it("replaces a symlink that points elsewhere", () => {
    writeFile(path.join(root, "elsewhere.conf"), "x\n");
    fs.symlinkSync(path.join(root, "elsewhere.conf"), link("jellyfin"));
    run();
    expect(commands()).toEqual([rm(link("jellyfin")), ln("jellyfin"), ln("photos")]);
  });

  it("replaces a regular file in the sites directory", () => {
    writeFile(link("jellyfin"), "stale copy\n");
    run();
    expect(commands()).toEqual([rm(link("jellyfin")), ln("jellyfin"), ln("photos")]);
    expect(out.log).toContain(symlinked("jellyfin"));
  });

  it("reports a failed link and carries on with the others", () => {
    const failure = new Error("ln: cannot create symbolic link");
    runCommand.mockImplementation((command) => {
      if (command.includes("jellyfin")) throw failure;
    });
    expect(run()).toBe(0);
    expect(console.error).toHaveBeenCalledTimes(1);
    expect(console.error).toHaveBeenCalledWith("Failed to link jellyfin.conf:", failure);
    expect(out.log).toEqual([
      generated("jellyfin"),
      generated("photos"),
      symlinked("photos"),
      footer(),
    ]);
  });

  it("reports a conf it cannot write, with the chown hint, and carries on", () => {
    const realWrite = fs.writeFileSync;
    jest.spyOn(fs, "writeFileSync").mockImplementation((file, data, options) => {
      if (String(file) === conf("jellyfin")) throw new Error("EACCES: permission denied");
      return realWrite(file, data, options);
    });
    expect(run()).toBe(0);
    expect(out.error).toEqual([
      `Failed to write ${conf("jellyfin")}: EACCES: permission denied\n` +
        `  (If it's owned by root from an older version, fix with: sudo chown $USER ${conf("jellyfin")})`,
    ]);
    expect(fs.existsSync(conf("jellyfin"))).toBe(false);
    expect(out.log).toEqual([generated("photos"), symlinked("photos"), footer()]);
  });

  it("shows a non-Error write failure as-is", () => {
    jest.spyOn(fs, "writeFileSync").mockImplementation(() => {
      throw "disk full";
    });
    run();
    expect(out.error[0]).toMatch(/^Failed to write .*jellyfin\.conf: disk full\n/);
    expect(out.error[1]).toMatch(/^Failed to write .*photos\.conf: disk full\n/);
  });

  it("links only .conf files and never example.conf", () => {
    writeFile(conf("example"), "# documentation only\n");
    writeFile(path.join(confsDir, ".htpasswd"), "bob:hash\n");
    writeFile(path.join(confsDir, "notes.txt"), "notes\n");
    run();
    expect(commands()).toEqual([ln("jellyfin"), ln("photos")]);
  });

  it("prefixes commands with sudo when the sites directory is not writable", () => {
    jest.spyOn(fs, "accessSync").mockImplementation(() => {
      throw new Error("EACCES");
    });
    writeFile(link("jellyfin"), "stale copy\n");
    run();
    expect(commands()).toEqual([
      rm(link("jellyfin"), "sudo "),
      ln("jellyfin", "sudo "),
      ln("photos", "sudo "),
    ]);
  });

  it("needs no sudo as root, writable directory or not", () => {
    jest.spyOn(fs, "accessSync").mockImplementation(() => {
      throw new Error("EACCES");
    });
    run({ isRoot: true });
    expect(commands()).toEqual([ln("jellyfin"), ln("photos")]);
  });

  describe("with the standard sites directory", () => {
    const std = (name: string) => path.join(STANDARD_SITES_DIR, `${name}.conf`);
    const stdLn = (name: string, sudo = "") => `${sudo}ln -s -- '${conf(name)}' '${std(name)}'`;

    it("links with sudo, then validates and reloads NGINX", () => {
      fakeStandardSitesDir(false);
      expect(run({ env: {} })).toBe(0);
      expect(commands()).toEqual([
        stdLn("jellyfin", "sudo "),
        stdLn("photos", "sudo "),
        "sudo nginx -t",
        "sudo systemctl reload nginx",
      ]);
      expect(runCommand).toHaveBeenCalledWith("sudo nginx -t", { stdio: "inherit" });
      expect(runCommand).toHaveBeenCalledWith("sudo systemctl reload nginx", { stdio: "inherit" });
      expect(out.log).toEqual([
        generated("jellyfin"),
        generated("photos"),
        `Symlinked: ${std("jellyfin")} → ${conf("jellyfin")}`,
        `Symlinked: ${std("photos")} → ${conf("photos")}`,
        "\nValidating NGINX config...",
        "Reloading NGINX...",
        "NGINX reloaded successfully!",
      ]);
      expect(out.error).toEqual([]);
    });

    it("returns 1 when nginx -t fails", () => {
      fakeStandardSitesDir(false);
      runCommand.mockImplementation((command) => {
        if (command.endsWith("nginx -t")) throw new Error("exit status 1");
      });
      expect(run({ env: {} })).toBe(1);
      expect(out.error).toEqual(["NGINX reload failed. Check the configuration above."]);
      expect(commands()).not.toContain("sudo systemctl reload nginx");
      expect(out.log).toContain("\nValidating NGINX config...");
      expect(out.log).not.toContain("Reloading NGINX...");
    });

    it("returns 1 when the reload fails", () => {
      fakeStandardSitesDir(false);
      runCommand.mockImplementation((command) => {
        if (command.endsWith("systemctl reload nginx")) throw new Error("exit status 1");
      });
      expect(run({ env: {} })).toBe(1);
      expect(out.error).toEqual(["NGINX reload failed. Check the configuration above."]);
      expect(out.log).toContain("Reloading NGINX...");
      expect(out.log).not.toContain("NGINX reloaded successfully!");
    });

    it("needs no sudo when the directory is writable", () => {
      fakeStandardSitesDir(true);
      expect(run({ env: {} })).toBe(0);
      expect(commands()).toEqual([
        stdLn("jellyfin"),
        stdLn("photos"),
        "nginx -t",
        "systemctl reload nginx",
      ]);
    });

    it("needs no sudo as root", () => {
      fakeStandardSitesDir(false);
      expect(run({ env: {}, isRoot: true })).toBe(0);
      expect(commands()).toContain("nginx -t");
    });

    it("treats an empty NGINX_SITES_DIR as the standard directory", () => {
      fakeStandardSitesDir(true);
      expect(run({ env: { NGINX_SITES_DIR: "" } })).toBe(0);
      expect(commands()).toEqual([
        stdLn("jellyfin"),
        stdLn("photos"),
        "nginx -t",
        "systemctl reload nginx",
      ]);
    });
  });

  describe("paths with spaces and quotes", () => {
    let quotedGenerator: string;
    let quotedSites: string;
    let src: string;
    let dest: string;

    beforeEach(() => {
      quotedGenerator = path.join(root, "it's a dir", "proxy-generator");
      quotedSites = path.join(root, "it's a dir", "sites 'x'");
      fs.mkdirSync(quotedGenerator, { recursive: true });
      fs.mkdirSync(quotedSites);
      src = path.join(quotedGenerator, "confs", "jellyfin.conf");
      dest = path.join(quotedSites, "jellyfin.conf");
    });

    it("quotes them for the shell", () => {
      const ctx = {
        generatorDir: quotedGenerator,
        env: { NGINX_SITES_DIR: quotedSites },
        runCommand,
      };
      expect(generateNginx(settingsFor(config), ctx)).toBe(0);
      expect(commands()[0]).toBe(`ln -s -- ${shellQuote(src)} ${shellQuote(dest)}`);
      expect(commands()[0]).toBe(
        `ln -s -- '${root}/it'\\''s a dir/proxy-generator/confs/jellyfin.conf' ` +
          `'${root}/it'\\''s a dir/sites '\\''x'\\''/jellyfin.conf'`,
      );
    });

    it("produces commands /bin/sh runs as intended", () => {
      // the default runCommand (execSync) against the temp tree only
      const ctx = { generatorDir: quotedGenerator, env: { NGINX_SITES_DIR: quotedSites } };
      expect(generateNginx(settingsFor(config), ctx)).toBe(0);
      expect(fs.readlinkSync(dest)).toBe(src);
      expect(out.error).toEqual([]);
    });
  });
});
