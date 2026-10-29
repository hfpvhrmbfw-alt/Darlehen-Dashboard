# Übertragung nach Swift

Ziel: Wenn die Web-Oberfläche wegfällt, bleiben Datenmodell, Rechenkern und Testfälle unverändert nutzbar. Diese Datei sagt, was 1:1 übertragen wird und was in Swift neu entsteht.

## Dateien und Schichten

| Datei | Schicht | In Swift |
|---|---|---|
| `src/model.js` | Modell | 1:1: `struct LoanInput: Codable`, `enum Variant`, `enum PlanMode`, `sanitize`, `parseImport`, `SCHEMA_VERSION` |
| `src/loan.js` | Logik | 1:1 als reine Funktionen (z. B. `enum Loan { static func compare(...) }`) |
| `tests/fixtures/*.json` | Testfälle | 1:1 ins Test-Bundle, gleiche Toleranz `1e-6` |
| `src/texts.js` | Texte | neu als String Catalog (`Localizable.xcstrings`), Schlüssel = Codes aus `validate` und `parseImport` |
| `src/format.js` | Anzeige | neu mit `FormatStyle` (`.currency(code: "EUR")`, Locale `de_DE`) |
| `src/storage.js` | Speicher | neu: Datei im App-Container oder SwiftData; Austausch über dasselbe JSON |
| `src/quotes.js` | Dienst | neu mit `URLSession` (in einer nativen App gibt es kein CORS, die Proxy-Kette entfällt) |
| `src/app.js`, `index.html` | Oberfläche | neu in SwiftUI |
| `src/worker.js` | Nebenläufigkeit | neu mit `Task` / `async let` |

## Datentypen (Skizze)

```swift
enum Variant: String, Codable { case A, B }
enum PlanMode: String, Codable { case standard, simple, custom }

struct PlanMonth: Codable, Equatable { var m: String; var a: Double }   // m = "JJJJ-MM"

struct LoanInput: Codable, Equatable {
    var crypto = 18800.0, cryptoGrowth = 10.0, etf = 11000.0, savings = 200.0
    var etfReturn = 6.0, volatility = 16.0, loan = 20000.0, loanRate = 0.0
    var grace = 10.0, term = 10.0, variant = Variant.A
    var ageNow = 30.0, ageTarget = 60.0, taxRate = 26.375, exemption = 30.0, inflation = 2.0
    var loanEtfNow = 0.0, planMode = PlanMode.standard, planAmount = 500.0
    var planStart = "", planCustom: [PlanMonth] = []
    var etfSymbol = "", etfShares = 0.0, loanShares = 0.0
    var refMonth: String? = nil   // "heute", kommt von der Oberfläche
}

struct Issue: Codable, Equatable { var code: String; var field: String? }   // Befunde aus validate

struct ExportFile: Codable {          // gleiches JSON wie die Web-App
    var app: String                    // "darlehen-tracker"
    var version: Int                   // SCHEMA_VERSION
    var exportiert: String             // ISO-8601
    var eingaben: LoanInput
}
```

## Regeln, die beide Seiten einhalten

- **Datum:** Monate als `"JJJJ-MM"`, Rechnung in ganzen Monaten (`monthDiff`, `addMonths`), keine Zeitzonen. „Heute“ wird immer als Parameter (`refMonth`) übergeben, nie im Rechenkern gelesen.
- **Rückgaben:** Zahlen und Codes, keine Texte. Ergebnisobjekte enthalten keine Funktionen.
- **Auswahllisten:** IDs (`A`, `B`, `standard`, `simple`, `custom`) nie umbenennen, nur ergänzen.
- **Zufall:** Die Monte-Carlo-Simulation nutzt mulberry32 mit Startwert `20261006` und Box-Muller. Für gleiche Ergebnisse in Swift dieselben Ganzzahl-Operationen (32 Bit, `&+`, `&*`) verwenden.
- **Import:** Dateien mit höherer `version` ablehnen, ältere über `upgradeRaw` hochheben, jede Eingabe durch `sanitize`.

## Ausblick Portfolio-Tracker

Für den geplanten Vermögens-Tracker kommen Konten, Positionen, Kurse und Stände dazu. Dort gelten zusätzlich: Beträge als ganze Cent (`Int`), Stückzahlen als `Decimal`, Datum als `"JJJJ-MM-TT"`, IDs als UUID-Strings. Liegt auf dem Mac schon ein Swift-Modell vor, richten sich die Feldnamen danach.
