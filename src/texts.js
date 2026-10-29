// Beschriftungen zu den IDs aus dem Modell und Meldungen zu den Codes aus der Logik.
// Später in Swift: String Catalog.
import { fmtNum } from './format.js';

export const LABELS = {
  crypto: 'Krypto-Depot heute', cryptoGrowth: 'Wachstum Krypto pro Jahr', etf: 'ETF-Bestand heute',
  savings: 'Monatliche ETF-Sparrate', etfReturn: 'ETF-Rendite pro Jahr', volatility: 'Schwankung',
  loan: 'Darlehen', loanRate: 'Darlehenszins', grace: 'Tilgungsfreie Zeit', term: 'Tilgung über',
  ageNow: 'Alter heute', ageTarget: 'Zielalter', taxRate: 'Steuer auf ETF-Gewinn',
  exemption: 'Teilfreistellung', inflation: 'Inflation',
};

const years = (mo) => fmtNum(mo / 12, mo % 12 ? 1 : 0);

/** Text zu einem Befund aus `validate` (loan.js). */
export function validationText(issue) {
  const v = issue;
  switch (v.code) {
    case 'not-a-number': return `Das Feld „${LABELS[v.field]}“ enthält keine gültige Zahl.`;
    case 'negative': return `Das Feld „${LABELS[v.field]}“ ist negativ; gerechnet wird mit 0.`;
    case 'no-horizon': return 'Das Zielalter muss über dem heutigen Alter liegen, sonst gibt es keinen Horizont.';
    case 'term-zero': return 'Die Tilgungsdauer ist 0 Jahre; das Darlehen würde nie getilgt.';
    case 'plan-exceeds-horizon': return `Tilgungsfreie Zeit (${years(v.graceMonths)} J.) und Tilgung (${years(v.termMonths)} J.) dauern länger als der Horizont (${v.horizonYears} J.); am Ende bleibt eine Restschuld.`;
    case 'payment-over-savings': return `Die Rate von ${fmtNum(v.payment, 0)} € ist höher als die Sparrate von ${fmtNum(v.savings, 0)} €. In Variante A muss die Differenz zusätzlich aus dem Einkommen kommen; das Modell zieht sie vom eigenen Depot ab.`;
    case 'plan-start-invalid': return 'Der Startmonat des Rückzahlungsplans ist ungültig (Format JJJJ-MM).';
    case 'plan-start-past': return 'Der Startmonat des Rückzahlungsplans liegt nicht in der Zukunft; gerechnet wird ab dem nächsten Monat.';
    case 'plan-amount-zero': return 'Die monatliche Auszahlung im Rückzahlungsplan ist 0 €; das Darlehen würde nie getilgt.';
    case 'plan-custom-empty': return 'Der individuelle Rückzahlungsplan enthält keine künftigen Monate mit Betrag; das Darlehen würde nie getilgt.';
    case 'plan-custom-past': return `${v.count} Monat(e) im individuellen Plan liegen nicht in der Zukunft und werden nicht gerechnet.`;
    case 'plan-custom-over': return `Der individuelle Plan zahlt ${fmtNum(v.sum, 0)} € zurück, das Darlehen beträgt ${fmtNum(v.loan, 0)} €. Gerechnet wird nur bis zur Restschuld 0.`;
    case 'plan-debt-left': return `Bis zum Horizont (${v.horizonYears} J.) ist das Darlehen laut Plan nicht getilgt; es bleibt eine Restschuld von ${fmtNum(v.debt, 0)} €.`;
    case 'exemption-over-100': return 'Die Teilfreistellung kann nicht über 100 % liegen.';
    case 'tax-over-100': return 'Der Steuersatz kann nicht über 100 % liegen.';
    case 'return-out-of-range': return 'Die ETF-Rendite liegt außerhalb der vorgesehenen Spanne von 3 bis 9 %.';
    case 'volatility-unrealistic': return 'Eine Schwankung über 60 % pro Jahr ist für einen Welt-ETF unrealistisch.';
    default: return v.code;
  }
}

/** Meldung zu einem Fehlercode aus `parseImport` (model.js). */
export const IMPORT_ERRORS = {
  'not-object': 'keine bekannten Felder',
  'no-fields': 'keine bekannten Felder',
  'newer-version': 'die Datei stammt aus einer neueren Version der App',
};
