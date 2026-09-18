// The golden scenario: the files and console output captured from the
// pre-refactor generate.ts (test/fixtures/golden) must be reproduced byte for
// byte. Starting point: confs/jellyfin.conf with custom lines and
// confs/photos.conf with the manual marker already exist, NGINX_SITES_DIR
// points at an empty directory, and nginx, caddy and traefik are generated in
// turn from the same config.
import fs from "fs";
import path from "path";
import { main } from "../src/cli";
import { captureConsole, makeTempDir, read, removeTempDir, type ConsoleCapture } from "./helpers";

const FIXTURES = path.join(__dirname, "fixtures", "golden");
// The tree the goldens were captured in — its absolute path is embedded in the
// captured output and file headers and gets replaced by this run's temp dir.
const GOLDEN_ROOT =
  "/tmp/claude-1000/-home-jelliott/a5d0b19a-042f-4c01-839a-3de10bb5d762/scratchpad/golden";

/** Every file below `dir`, as sorted paths relative to it. */
function listFiles(dir: string, prefix = ""): string[] {
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .flatMap((entry) =>
      entry.isDirectory()
        ? listFiles(path.join(dir, entry.name), path.join(prefix, entry.name))
        : [path.join(prefix, entry.name)],
    )
    .sort();
}

describe("golden scenario", () => {
  let root: string;
  let out: ConsoleCapture;

  const repo = () => path.join(root, "repo");
  const generatorDir = () => path.join(repo(), "proxy-generator");
  const confs = () => path.join(generatorDir(), "confs");
  const sites = () => path.join(root, "sites");
  const expected = (name: string) =>
    read(path.join(FIXTURES, "expected", name))
      .split(GOLDEN_ROOT)
      .join(root);
  const stdout = () => out.log.join("\n") + "\n";
  const run = (proxy: string) =>
    main(["--proxy", proxy, path.join(root, "config.json")], {
      generatorDir: generatorDir(),
      env: { NGINX_SITES_DIR: sites() },
    });

  beforeAll(() => {
    root = makeTempDir();
    fs.mkdirSync(confs(), { recursive: true });
    fs.mkdirSync(sites());
    fs.copyFileSync(path.join(FIXTURES, "golden-config.json"), path.join(root, "config.json"));
    for (const name of ["jellyfin.conf", "photos.conf"]) {
      fs.copyFileSync(path.join(FIXTURES, "before", "confs", name), path.join(confs(), name));
    }
  });
  afterAll(() => removeTempDir(root));
  beforeEach(() => {
    out = captureConsole();
  });

  it("nginx: regenerates jellyfin.conf around its custom lines, keeps photos.conf, links both", () => {
    expect(run("nginx")).toBe(0);
    expect(stdout()).toBe(expected("nginx.stdout"));
    expect(out.warn).toEqual([]);
    expect(out.error).toEqual([]);
    expect(read(path.join(confs(), "jellyfin.conf"))).toBe(
      expected("proxy-generator/confs/jellyfin.conf"),
    );
    expect(read(path.join(confs(), "photos.conf"))).toBe(
      expected("proxy-generator/confs/photos.conf"),
    );
    // the real `ln -s` ran against the temp sites dir
    expect(fs.readdirSync(sites()).sort()).toEqual(["jellyfin.conf", "photos.conf"]);
    for (const name of ["jellyfin.conf", "photos.conf"]) {
      expect(fs.readlinkSync(path.join(sites(), name))).toBe(path.join(confs(), name));
    }
  });

  it("caddy: writes the Caddyfile and docker-compose.override.yml", () => {
    expect(run("caddy")).toBe(0);
    expect(stdout()).toBe(expected("caddy.stdout"));
    expect(out.warn).toEqual([]);
    expect(out.error).toEqual([]);
    expect(read(path.join(generatorDir(), "Caddyfile"))).toBe(
      expected("proxy-generator/Caddyfile"),
    );
    expect(read(path.join(repo(), "docker-compose.override.yml"))).toBe(
      expected("docker-compose.override.golden.yml"),
    );
  });

  it("traefik: writes traefik-dynamic.yml", () => {
    expect(run("traefik")).toBe(0);
    expect(stdout()).toBe(expected("traefik.stdout"));
    expect(out.warn).toEqual([]);
    expect(out.error).toEqual([]);
    expect(read(path.join(generatorDir(), "traefik-dynamic.yml"))).toBe(
      expected("proxy-generator/traefik-dynamic.yml"),
    );
  });

  it("wrote nothing else", () => {
    expect(listFiles(repo())).toEqual([
      "docker-compose.override.yml",
      "proxy-generator/Caddyfile",
      "proxy-generator/confs/jellyfin.conf",
      "proxy-generator/confs/photos.conf",
      "proxy-generator/traefik-dynamic.yml",
    ]);
  });
});
