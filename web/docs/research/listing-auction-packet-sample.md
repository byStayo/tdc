# Replaying the September 21 listing-auction sample

This offline check identifies the actual opening and closing executions for five ETFs on September 21, 2026. It pairs each execution with a separately disseminated official price. It prints aggregate counts and has no writer for settlements, scores or the public archive.

| Listing | Funds | Original and check |
| --- | --- | --- |
| NYSE Arca | DIA, IWM, SPY | CTA Tape B production lines 1, 5 and 8 respectively. Both the reporting participant and listing participant are P. The two redundant broadcast paths must carry the identical execution and official-price messages. |
| Nasdaq | QQQ, TLT | UTP Tape C production channels 5 and 6 respectively. The originator is Q. Both messages must also match the dated opening or closing share count in Nasdaq CrossStats. |

The protocols identify a single-price execution with sale condition O at the open or 6 at the close. Q and M identify the official price reports. The reader checks the transaction identifiers, native timestamps, price and size separately. An opening buyer's entitlement to an issuer distribution requires a separate corporate-action check. Packet prices are as traded. [CTA binary specification, sections 5 and 6.7](https://www.ctaplan.com/publicdocs/ctaplan/CTS_Pillar_Output_Specification.pdf) · [CTA production multicast groups, appendix 5](https://www.ctaplan.com/publicdocs/ctaplan/Common_IP_Multicast_Distribution_Network_Specification.pdf) · [Nasdaq UTP specification, section 2.3](https://www.utpplan.com/DOC/UtpBinaryOutputSpec.pdf) · [UTP production channels](https://www.utpplan.com/DOC/IP_Addresses_for_UTP_Data_Feed_Services.pdf) · [Dated Nasdaq cross volumes](https://www.nasdaqtrader.com/files/crosses/CrossStats20260921.txt)

## Preparing the private inputs

Use the provider's public September 21 CTA CTS A, CTA CTS B, and UTP UTDF A sample links. The source exposes a 10-minute file at 13:30 UTC and a full-session ZIP for each of these paths. Keep captures, HTTP headers and the manifest in an ignored private directory. Use subject matter and licensing appropriate to the evaluation. The sample establishes the meaning of specified messages on one ordinary session. A recurring data or model license requires a separate grant. [Provider announcement](https://databento.com/blog/cta-utp-sip-pcaps) · [PCAP samples and licensing](https://databento.com/pcaps)

1. Retain the first 4 MiB of the advertised 13:30 UTC file as an HTTP range starting at byte zero. Keep its SHA-256, URL, HTTP 206 status, exact inclusive range, response length and strong ETag.
2. For each ZIP, request the final 64 KiB. Locate the exact `T200000.pcap.zst` member in its central directory. Use its local-header offset for a second range with the same strong ETag sent as `If-Match`. Request at most 4 MiB plus 512 bytes for the header. Save the response metadata for both ranges. The verifier checks the member name and size, local and central headers, object version and the CRC for a complete member. Two multicast paths carry the same CTA source.
3. Retain the dated Nasdaq cross-volume file. The replay requires its original URL, HTTP 200, completeness, local file and SHA-256 of the original bytes. It accepts plain or gzip-preserved CSV. Nasdaq cross volumes corroborate the Nasdaq-listed funds only. The Arca packet sample provides no second exchange copy of the daily auction-volume file.
4. In a local manifest set `session` to `2026-09-21`, set `nasdaqCrossStats` to the name of its receipt, and provide `paths` for `cta-a`, `cta-b` and `utp-a`. Each maps `open`, `close` and `directory` to the corresponding local JSON range-receipt filenames. The receipts and their binary objects reside beside the manifest.

Each range receipt contains `source`, `status`, `object`, `range` as inclusive integer offsets, `sha256`, and `headers` with `content-length`, `content-range` and `etag`. The cross-volume receipt contains `source`, `http`, `complete`, `object` and `sha256`. Use the response digests measured when the originals were acquired.

## Running the replay

From `web`, with Python 3 and the local `zstd` decoder, run the following commands.

```sh
python3 -B scripts/qualify_listing_auctions.py /path/to/private/manifest.json
python3 -B -m unittest discover -s tests -p test_listing_auction_packets.py
```

The genuine sample yielded ten listing executions and ten distinct official prices. Twelve Arca messages matched byte for byte across both paths. Nasdaq's separate share counts matched all four Nasdaq auctions. The bounded windows cannot establish full-day or later corrections. Other dates, shortened sessions and production outcomes are outside this sample's scope.
