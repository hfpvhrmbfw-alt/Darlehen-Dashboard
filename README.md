# Darlehen-Tracker (Darlehen-Dashboard)

Gedankenspiel: Ein zinsloses (oder zinsarmes) Familiendarlehen der Eltern wird komplett in einen Welt-ETF (All-World) investiert. Das Dashboard zeigt, was das für das Vermögen bedeutet, wie lange es bis 100.000 € dauert und wie hoch das Risiko ist.

> **HINWEIS** Gedankenrechnung, keine Anlage-, Rechts- oder Steuerberatung. Alle Renditen sind Annahmen und keine Prognose.

Installierbare PWA, rein statisch: kein Build-Schritt, keine Abhängigkeiten zur Laufzeit, keine Fremdanfragen. Schriften und Icons liegen im Repo.

## Struktur

```
index.html             Markup und CSS (Hausstil Web v1.2, Hell/Dunkel)
app.js                 Oberfläche, Zustand (localStorage), Diagramme (Inline-SVG)
calc.js                Rechenkern als reine Funktionen ohne DOM
worker.js              Web Worker für die Monte-Carlo-Simulation
sw.js                  Service Worker (vorab zwischenspeichern, Cache zuerst)
manifest.webmanifest   PWA-Manifest
fonts/                 woff2, selbst gehostet (SIL Open Font License, Lizenztexte liegen bei)
icons/                 favicon.svg, 192, 512, maskable 512, apple-touch-icon 180
tests/calc.test.mjs    Prüfwerte, ausführen mit node --test
package.json           nur "type": "module" und das Test-Skript, keine Pakete
.github/workflows/     test.yml führt nur die Tests aus (kein Deployment)
```

## Lokal starten

Ein Service Worker läuft nur über `http://localhost` oder `https://`, nicht per Doppelklick auf `index.html`.

```sh
python3 -m http.server 8000
# dann http://localhost:8000/ öffnen
```

## Tests

```sh
node --test
```

Node 20 oder neuer. Die Tests prüfen die Prüfwerte (Abweichung höchstens 1 %, Simulation mit den angegebenen Toleranzen) und einige Plausibilitäten.

## Rechenmodell (calc.js)

Monatsschritte über den Horizont (Zielalter − Alter heute):

- Krypto: `c = c · (1 + g)^(1/12)`
- ETF, eigenes Depot: `e = e · (1 + r)^(1/12) + Sparrate`
- Darlehensgeld im ETF: `l = l · (1 + r)^(1/12)`
- Variante A: Ab Ende der tilgungsfreien Zeit wird jeden Monat Darlehen/Laufzeit von `e` abgezogen und die Schuld um denselben Betrag gesenkt.
- Variante B: Die Rate wird durch Verkauf aus dem Darlehens-Depot `l` bezahlt; der Gewinnanteil des Verkaufs wird versteuert (26,375 % auf 70 %). Reicht `l` nicht, wird der Rest aus `e` verkauft.
- Zinsen laufen monatlich auf die Restschuld auf und werden jährlich aus dem Einkommen bezahlt, also wie die Rate in Variante A vom eigenen Depot abgezogen.
- Gesamtvermögen = `c + e + l − Restschuld`; Zeit bis 100.000 € = erster Monat mit Gesamtvermögen ≥ 100.000 €.
- Netto: ETF-Gewinn über dem Einstandswert nach Steuer. Real: geteilt durch `(1 + Inflation)^(Jahre)`.
- Monte-Carlo: 20.000 Durchläufe mit festem Zufallswert, Monatsrenditen logarithmisch normalverteilt mit `mu = ln(1 + r)/12`, `sigma = Schwankung/√12`. Krypto wird dabei fest mit `g` gerechnet.

Annahmen, die nicht ausdrücklich vorgegeben waren: Krypto wird ohne Steuer und ohne Schwankung gerechnet; der Einstandswert des heutigen ETF-Bestands gilt als gleich seinem Wert; „Depot reicht nicht“ in Variante B heißt, dass das Darlehens-Depot nicht alle Raten trägt.

## Datenschutz und Netz

- Eingaben bleiben im Browser (localStorage). Export und Import als JSON-Datei.
- Nach dem ersten Laden kommen alle Dateien aus dem Service-Worker-Cache. Die App selbst stellt keine Anfragen; der Browser prüft nur bei einem Seitenaufruf, ob sich `sw.js` geändert hat (gleiche Adresse, nötig für die UPDATE-Note).

## Neue Version veröffentlichen

Nach jeder Änderung an einer App-Datei in `sw.js` die Konstante `VERSION` erhöhen. Dann erscheint bei allen, die die App schon geöffnet hatten, die Note **UPDATE** mit dem Button „Neu laden“, und der alte Cache wird gelöscht.

## Repository und Live-Version

- Repository: https://github.com/hfpvhrmbfw-alt/Darlehen-Dashboard
- Live (GitHub Pages): https://hfpvhrmbfw-alt.github.io/Darlehen-Dashboard/

Lokal weiterarbeiten:

```sh
git clone https://github.com/hfpvhrmbfw-alt/Darlehen-Dashboard.git
cd Darlehen-Dashboard
node --test
```

## GitHub Pages einrichten

1. Im Repository: **Settings → Pages**.
2. Bei **Build and deployment** als Quelle **Deploy from a branch** wählen, Branch `main`, Ordner `/ (root)`, speichern.
3. Nach kurzer Zeit läuft die App unter https://hfpvhrmbfw-alt.github.io/Darlehen-Dashboard/.

Alle Pfade sind relativ (`./`), `start_url` und `scope` sind `./`, deshalb funktioniert die App ohne Änderung im Unterpfad `/Darlehen-Dashboard/`. `.nojekyll` sorgt dafür, dass GitHub die Dateien unverändert ausliefert. Über HTTPS lässt sich die App dann im Browser installieren („Zum Startbildschirm hinzufügen“ bzw. „App installieren“).

## Lizenzen

Schriften: IBM Plex Mono, IBM Plex Sans (IBM) und Source Serif 4 (Adobe), jeweils SIL Open Font License 1.1, bezogen über die npm-Pakete `@fontsource/*`. Lizenztexte in `fonts/`.
