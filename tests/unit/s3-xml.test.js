import assert from "node:assert/strict";
import { test } from "node:test";

import {
  collectXmlFields,
  listXmlTagValues,
  xmlTagValueIsTrue,
  xmlEscape,
  xmlLocalName,
  xmlUnescape,
} from "../../shared/s3-xml.js";

test("xmlEscape escapes XML text and attribute delimiters", () => {
  assert.equal(
    xmlEscape(`<tag attr="a&b">'value'</tag>`),
    "&lt;tag attr=&quot;a&amp;b&quot;&gt;&apos;value&apos;&lt;/tag&gt;",
  );
  assert.equal(xmlEscape("plain"), "plain");
});

test("xmlUnescape decodes named, decimal, and hex entities in order", () => {
  assert.equal(
    xmlUnescape("&lt;Key&gt;rock &amp; roll &#39;single&#x27; &quot;double&quot;&lt;/Key&gt;"),
    "<Key>rock & roll 'single' \"double\"</Key>",
  );
  assert.equal(xmlUnescape("plain"), "plain");
});

test("xmlUnescape preserves invalid numeric entities instead of throwing", () => {
  assert.equal(xmlUnescape("bad=&#x110000;"), "bad=&#x110000;");
  assert.equal(xmlUnescape("huge=&#999999999999999999999999;"), "huge=&#999999999999999999999999;");
});

test("xmlLocalName strips namespace prefixes", () => {
  assert.equal(xmlLocalName("ns:Foo"), "Foo");
  assert.equal(xmlLocalName("Foo"), "Foo");
  assert.equal(xmlLocalName("a:b:c"), "c");
});

test("listXmlTagValues returns ordered local-name tag matches", () => {
  const xml = [
    "<Key>alpha&amp;one</Key>",
    "<s3:Key>beta&#x2f;two</s3:Key>",
    "<Tag.Name>literal-dot</Tag.Name>",
    "<aws:Tag.Name>prefixed-dot</aws:Tag.Name>",
    "<TagxName>not-a-dot-match</TagxName>",
  ].join("");

  assert.deepEqual(listXmlTagValues(xml, "Key"), ["alpha&one", "beta/two"]);
  assert.deepEqual(listXmlTagValues(xml, "Tag.Name"), ["literal-dot", "prefixed-dot"]);
  assert.deepEqual(listXmlTagValues(xml, "Missing"), []);
});

test("xmlTagValueIsTrue checks namespaced boolean tags", () => {
  assert.equal(xmlTagValueIsTrue("<s3:IsTruncated>true</s3:IsTruncated>", "IsTruncated"), true);
  assert.equal(xmlTagValueIsTrue("<IsTruncated>false</IsTruncated>", "IsTruncated"), false);
});

test("collectXmlFields returns requested local-name fields", () => {
  assert.deepEqual(
    collectXmlFields([
      "<aws:Key>a&amp;b.txt</aws:Key>",
      "<Size>7</Size>",
      "<Ignored>nope</Ignored>",
    ].join(""), new Set(["Key", "Size"])),
    { Key: "a&b.txt", Size: "7" }
  );
});
