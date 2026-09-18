import { PROXY_PREFIX_RE, createHostRouter } from "../src/routing";
import { type ServiceMap } from "../src/config";

const services: ServiceMap = {
  jellyfin: { route: "jellyfin", target: "http://localhost:8096" },
  photos: {
    route: "photos",
    target: "http://localhost:2283",
    domains: ["Photos.example.org", "pics.example.net"],
  },
  minecraft: { route: "minecraft", target: "localhost:25565", type: "tcp", listenPort: 25566 },
};

const req = (headers: Record<string, string | string[] | undefined>, url?: string) => ({
  headers,
  url,
});

describe("createHostRouter", () => {
  const router = createHostRouter(services, "Example.com");

  it("maps <route>.<domain> and aliases (lowercased) to routes, skipping tcp services", () => {
    expect(router.hosts).toEqual({
      "jellyfin.example.com": "jellyfin",
      "photos.example.com": "photos",
      "photos.example.org": "photos",
      "pics.example.net": "photos",
    });
  });

  it("works without a domain: aliases and first-label fallback only", () => {
    const noDomain = createHostRouter(services);
    expect(noDomain.hosts).toEqual({
      "photos.example.org": "photos",
      "pics.example.net": "photos",
    });
    expect(noDomain.routeForHost(req({ host: "jellyfin.anything.tld" }))).toBe("jellyfin");
    expect(noDomain.routeForHost(req({ host: "pics.example.net" }))).toBe("photos");
  });

  describe("routeForHost", () => {
    it("matches the Host header, ignoring case and port", () => {
      expect(router.routeForHost(req({ host: "jellyfin.example.com" }))).toBe("jellyfin");
      expect(router.routeForHost(req({ host: "JELLYFIN.Example.COM:8080" }))).toBe("jellyfin");
      expect(router.routeForHost(req({ host: "pics.example.net:443" }))).toBe("photos");
    });

    it("prefers X-Forwarded-Host over Host, taking the first of a list", () => {
      expect(
        router.routeForHost(
          req({ host: "jellyfin.example.com", "x-forwarded-host": "photos.example.com" }),
        ),
      ).toBe("photos");
      expect(
        router.routeForHost(req({ "x-forwarded-host": "photos.example.com, other.example.com" })),
      ).toBe("photos");
      expect(router.routeForHost(req({ "x-forwarded-host": ["pics.example.net", "x"] }))).toBe(
        "photos",
      );
    });

    it("falls back to the first DNS label matching a route name", () => {
      expect(router.routeForHost(req({ host: "jellyfin.other.tld" }))).toBe("jellyfin");
      expect(router.routeForHost(req({ host: "jellyfin" }))).toBe("jellyfin");
    });

    it("never routes to tcp services by hostname", () => {
      expect(router.routeForHost(req({ host: "minecraft.example.com" }))).toBeNull();
    });

    it("returns null for unknown or missing hostnames", () => {
      expect(router.routeForHost(req({ host: "unknown.example.com" }))).toBeNull();
      expect(router.routeForHost(req({ host: "" }))).toBeNull();
      expect(router.routeForHost(req({}))).toBeNull();
      expect(router.routeForHost(req({ "x-forwarded-host": [] }))).toBeNull();
    });
  });

  describe("routeForUpgrade", () => {
    const proxied = (route: string) => route === "jellyfin";

    it("uses the /proxy/<route> prefix first", () => {
      expect(
        router.routeForUpgrade(
          req({ host: "photos.example.com" }, "/proxy/jellyfin/socket"),
          proxied,
        ),
      ).toBe("jellyfin");
      expect(router.routeForUpgrade(req({}, "/proxy/jellyfin?x=1"), proxied)).toBe("jellyfin");
      expect(router.routeForUpgrade(req({}, "/proxy/jellyfin"), proxied)).toBe("jellyfin");
    });

    it("ignores prefixes that are not proxied services and falls back to the hostname", () => {
      expect(
        router.routeForUpgrade(req({ host: "jellyfin.example.com" }, "/proxy/photos/ws"), proxied),
      ).toBe("jellyfin");
      expect(
        router.routeForUpgrade(req({ host: "jellyfin.example.com" }, "/proxy/nope/ws"), proxied),
      ).toBe("jellyfin");
      expect(
        router.routeForUpgrade(req({ host: "jellyfin.example.com" }, "/proxy/jellyfinx"), proxied),
      ).toBe("jellyfin");
    });

    it("returns null when neither prefix nor hostname yields a proxied service", () => {
      expect(
        router.routeForUpgrade(req({ host: "photos.example.com" }, "/ws"), proxied),
      ).toBeNull();
      expect(router.routeForUpgrade(req({}, undefined), proxied)).toBeNull();
    });
  });
});

describe("PROXY_PREFIX_RE", () => {
  it("captures the route only when followed by /, ? or the end", () => {
    expect(PROXY_PREFIX_RE.exec("/proxy/app/x")?.[1]).toBe("app");
    expect(PROXY_PREFIX_RE.exec("/proxy/app?x")?.[1]).toBe("app");
    expect(PROXY_PREFIX_RE.exec("/proxy/app")?.[1]).toBe("app");
    expect(PROXY_PREFIX_RE.exec("/proxy/app_x")).toBeNull();
    expect(PROXY_PREFIX_RE.exec("/other/app")).toBeNull();
  });
});
