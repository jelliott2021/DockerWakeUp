/**
 * Runs the Postman collection against a freshly started proxy with newman.
 *
 *   npm run test:api        (builds wake-proxy first)
 *
 * The same collection can be imported into Postman; the environment values
 * printed at startup are what to put in a Postman environment.
 */
import { createRequire } from "module";
import type { Faker } from "@faker-js/faker";
import type * as Newman from "newman";
import path from "path";
import { startHarness } from "../support/harness";

const COLLECTION = path.join(__dirname, "DockerWakeUp.postman_collection.json");

const loadModule = createRequire(__filename);
const fakerLocalePath = loadModule.resolve("@faker-js/faker/locale/en");
const fakerLocale = loadModule(fakerLocalePath) as { faker: Faker };
const faker = fakerLocale.faker;
// Newman still expects Faker v5 names; adapt its dynamic-variable module to patched Faker.
const namespace = (
  value: unknown,
  aliases: Record<string, unknown> = {},
): Record<string, unknown> => {
  const target =
    typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
  return new Proxy(target, {
    get(current, property: string | symbol) {
      if (typeof property === "string" && property in aliases) return aliases[property];
      const member = Reflect.get(current, property, current) as unknown;
      if (member === undefined) {
        return () => {
          throw new Error(`Unsupported Newman Faker method: ${String(property)}`);
        };
      }
      if (typeof member === "function") return member.bind(current);
      if (typeof member === "object" && member !== null) return namespace(member);
      return member;
    },
  });
};
const compatibilityFaker = namespace(faker, {
  address: namespace(faker.location),
  random: namespace(
    {},
    {
      arrayElement: faker.helpers.arrayElement,
      word: faker.lorem.word,
      alphaNumeric: faker.string.alphanumeric,
    },
  ),
  commerce: namespace(faker.commerce, {
    color: faker.color.rgb,
  }),
  company: namespace(faker.company, {
    companyName: faker.company.name,
    companySuffix: faker.company.name,
    catchPhrase: faker.company.buzzPhrase,
    bs: faker.company.buzzPhrase,
    catchPhraseAdjective: faker.company.buzzAdjective,
    catchPhraseDescriptor: faker.company.buzzAdjective,
    catchPhraseNoun: faker.company.buzzNoun,
    bsAdjective: faker.company.buzzAdjective,
    bsBuzz: faker.company.buzzVerb,
    bsNoun: faker.company.buzzNoun,
  }),
  datatype: namespace(faker.datatype, {
    number: faker.number.int,
    uuid: faker.string.uuid,
  }),
  image: namespace(faker.image, {
    imageUrl: faker.image.url,
  }),
  internet: namespace(faker.internet, {
    color: faker.color.rgb,
    userName: faker.internet.username,
  }),
  name: namespace(faker.person, {
    findName: faker.person.fullName,
  }),
  phone: namespace(faker.phone, {
    phoneNumberFormat: faker.phone.number,
  }),
});
const fakerEntry = loadModule.cache[fakerLocalePath];
if (!fakerEntry) throw new Error("Cannot install Newman Faker compatibility adapter");
fakerEntry.exports = new Proxy(compatibilityFaker, {
  get(target, property: string | symbol) {
    if (property === "faker") return faker;
    return Reflect.get(target, property, target) as unknown;
  },
});
const newman = loadModule("newman") as typeof Newman;

async function main(): Promise<number> {
  const harness = await startHarness();
  const envValues = {
    baseUrl: harness.baseUrl,
    domain: harness.domain,
    upHost: harness.up.host,
    sleepyHost: harness.sleepy.host,
    dozyHost: harness.dozy.host,
    neverHost: harness.never.host,
    customHost: harness.custom.host,
    upPort: String(harness.up.port),
  };
  console.log("Postman environment:", envValues);

  try {
    return await new Promise<number>((resolve, reject) => {
      newman.run(
        {
          collection: COLLECTION,
          envVar: Object.entries(envValues).map(([key, value]) => ({ key, value })),
          reporters: ["cli"],
          timeoutRequest: 10_000,
          bail: false,
        },
        (err, summary) => {
          if (err) return reject(err);
          const failures = summary.run.failures.length;
          const errors = summary.error ? 1 : 0;
          resolve(failures + errors > 0 ? 1 : 0);
        },
      );
    });
  } finally {
    await harness.stop();
  }
}

main()
  .then((code) => process.exit(code))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
