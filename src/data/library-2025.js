/* ============================================================================
   REFERENCE DATA — calendar year 2025
   Split out from the tool so it can be updated on its own each year without
   touching the engine. Nothing here is computed; it is all published or
   observed data, with the source named next to it.
   ==========================================================================*/

/* ============================================================================
   LOCATION AND RESOURCE LIBRARY
   Every entry is an indicative reference value, not site data. Yields are P50
   annual specific yield for a fixed, optimally tilted, ground-mounted system.
   monthlyYieldShare is normalised in code — the numbers below are relative.
   ========================================================================== */

export const LOCATION_LIBRARY = {
  FR_PARIS: {
    label: "Paris, France", country: "FR", lat: 48.86,
    specificYield_kWh_per_kWp: 1180,
    monthlyYieldShare: [2.5, 4.0, 7.5, 10.5, 12.5, 13.0, 13.5, 12.0, 9.0, 6.0, 3.0, 2.0],
    tempMeanC: [5, 6, 9, 12, 16, 19, 21, 21, 17, 13, 8, 5],
    diurnalSwingC: 8,
    windMean_m_s_100m: 6.5, weibullK: 2.0,
    gridCO2_g_per_kWh: 60, importTariff_EUR_per_MWh: 95, gridFee_EUR_per_MWh: 28,
    capacityCharge_EUR_per_kW_yr: 42, diesel_EUR_per_litre: 1.25, gas_EUR_per_MWh_th: 45,
  },
  FR_MARSEILLE: {
    label: "Marseille, France", country: "FR", lat: 43.30,
    specificYield_kWh_per_kWp: 1500,
    monthlyYieldShare: [4.5, 5.8, 8.5, 10.0, 11.5, 12.5, 13.0, 11.8, 9.5, 6.8, 4.5, 3.8],
    tempMeanC: [7, 8, 11, 14, 18, 22, 25, 25, 21, 17, 11, 8],
    diurnalSwingC: 9,
    windMean_m_s_100m: 7.5, weibullK: 1.9,
    gridCO2_g_per_kWh: 60, importTariff_EUR_per_MWh: 95, gridFee_EUR_per_MWh: 28,
    capacityCharge_EUR_per_kW_yr: 42, diesel_EUR_per_litre: 1.25, gas_EUR_per_MWh_th: 45,
  },
  NL_AMSTERDAM: {
    label: "Amsterdam, Netherlands", country: "NL", lat: 52.37,
    specificYield_kWh_per_kWp: 1050,
    monthlyYieldShare: [2.0, 3.5, 7.0, 10.5, 12.8, 13.2, 13.5, 11.8, 8.8, 5.5, 2.6, 1.6],
    tempMeanC: [4, 4, 7, 10, 14, 17, 19, 18, 15, 11, 8, 5],
    diurnalSwingC: 6,
    windMean_m_s_100m: 8.5, weibullK: 2.1,
    gridCO2_g_per_kWh: 300, importTariff_EUR_per_MWh: 105, gridFee_EUR_per_MWh: 35,
    capacityCharge_EUR_per_kW_yr: 55, diesel_EUR_per_litre: 1.45, gas_EUR_per_MWh_th: 42,
  },
  DE_FRANKFURT: {
    label: "Frankfurt, Germany", country: "DE", lat: 50.11,
    specificYield_kWh_per_kWp: 1080,
    monthlyYieldShare: [2.2, 3.8, 7.2, 10.5, 12.6, 13.0, 13.4, 12.0, 9.0, 5.8, 2.8, 1.8],
    tempMeanC: [2, 3, 7, 11, 15, 18, 20, 20, 15, 11, 6, 3],
    diurnalSwingC: 9,
    windMean_m_s_100m: 6.0, weibullK: 2.0,
    gridCO2_g_per_kWh: 350, importTariff_EUR_per_MWh: 120, gridFee_EUR_per_MWh: 45,
    capacityCharge_EUR_per_kW_yr: 90, diesel_EUR_per_litre: 1.40, gas_EUR_per_MWh_th: 45,
  },
  UK_LONDON: {
    label: "London, United Kingdom", country: "UK", lat: 51.51,
    specificYield_kWh_per_kWp: 1010,
    monthlyYieldShare: [2.2, 3.6, 6.8, 10.2, 12.5, 13.0, 13.2, 11.8, 9.0, 5.8, 2.9, 1.9],
    tempMeanC: [5, 5, 8, 10, 14, 17, 19, 19, 16, 12, 8, 6],
    diurnalSwingC: 7,
    windMean_m_s_100m: 8.0, weibullK: 2.1,
    gridCO2_g_per_kWh: 200, importTariff_EUR_per_MWh: 130, gridFee_EUR_per_MWh: 40,
    capacityCharge_EUR_per_kW_yr: 70, diesel_EUR_per_litre: 1.50, gas_EUR_per_MWh_th: 40,
  },
  ES_MADRID: {
    label: "Madrid, Spain", country: "ES", lat: 40.42,
    specificYield_kWh_per_kWp: 1650,
    monthlyYieldShare: [5.0, 6.0, 8.6, 9.8, 11.2, 12.4, 13.2, 12.2, 9.6, 7.0, 5.0, 4.2],
    tempMeanC: [6, 8, 11, 13, 17, 23, 26, 26, 21, 15, 10, 7],
    diurnalSwingC: 12,
    windMean_m_s_100m: 6.0, weibullK: 1.9,
    gridCO2_g_per_kWh: 150, importTariff_EUR_per_MWh: 90, gridFee_EUR_per_MWh: 30,
    capacityCharge_EUR_per_kW_yr: 35, diesel_EUR_per_litre: 1.30, gas_EUR_per_MWh_th: 42,
  },
  ES_EXTREMADURA: {
    label: "Badajoz, Extremadura, Spain", country: "ES", lat: 38.88,
    specificYield_kWh_per_kWp: 1820,
    monthlyYieldShare: [5.2, 6.2, 8.8, 9.6, 11.0, 12.0, 12.9, 12.1, 9.7, 7.3, 5.3, 4.4],
    tempMeanC: [9, 11, 14, 16, 20, 25, 28, 28, 24, 18, 13, 10],
    diurnalSwingC: 14,
    windMean_m_s_100m: 5.2, weibullK: 1.8,
    gridCO2_g_per_kWh: 150, importTariff_EUR_per_MWh: 90, gridFee_EUR_per_MWh: 30,
    capacityCharge_EUR_per_kW_yr: 35, diesel_EUR_per_litre: 1.30, gas_EUR_per_MWh_th: 42,
  },
  SA_RIYADH: {
    label: "Riyadh, Saudi Arabia (sunbelt)", country: "SA", lat: 24.71,
    specificYield_kWh_per_kWp: 1750,
    monthlyYieldShare: [6.5, 7.2, 8.7, 9.0, 9.5, 9.8, 9.5, 9.4, 9.0, 8.2, 7.0, 6.2],
    tempMeanC: [15, 17, 22, 27, 32, 34, 36, 36, 33, 28, 21, 16],
    diurnalSwingC: 14,
    windMean_m_s_100m: 6.0, weibullK: 2.2,
    gridCO2_g_per_kWh: 600, importTariff_EUR_per_MWh: 45, gridFee_EUR_per_MWh: 8,
    capacityCharge_EUR_per_kW_yr: 12, diesel_EUR_per_litre: 0.55, gas_EUR_per_MWh_th: 12,
  },
  AE_ABUDHABI: {
    label: "Abu Dhabi, UAE (sunbelt)", country: "AE", lat: 24.45,
    specificYield_kWh_per_kWp: 1700,
    monthlyYieldShare: [6.6, 7.3, 8.6, 9.1, 9.6, 9.7, 9.3, 9.2, 9.1, 8.4, 7.1, 6.3],
    tempMeanC: [19, 20, 23, 27, 32, 34, 36, 36, 33, 30, 25, 21],
    diurnalSwingC: 11,
    windMean_m_s_100m: 5.5, weibullK: 2.2,
    gridCO2_g_per_kWh: 480, importTariff_EUR_per_MWh: 60, gridFee_EUR_per_MWh: 10,
    capacityCharge_EUR_per_kW_yr: 15, diesel_EUR_per_litre: 0.75, gas_EUR_per_MWh_th: 18,
  },
  CL_ATACAMA: {
    label: "Antofagasta / Atacama, Chile (remote mine)", country: "CL", lat: -23.65,
    specificYield_kWh_per_kWp: 2100,
    monthlyYieldShare: [10.2, 9.4, 9.0, 7.8, 6.6, 6.0, 6.4, 7.2, 8.4, 9.4, 9.8, 9.8],
    tempMeanC: [21, 21, 20, 18, 16, 15, 14, 14, 15, 17, 18, 20],
    diurnalSwingC: 8,
    windMean_m_s_100m: 7.5, weibullK: 2.4,
    gridCO2_g_per_kWh: 350, importTariff_EUR_per_MWh: 110, gridFee_EUR_per_MWh: 20,
    capacityCharge_EUR_per_kW_yr: 25, diesel_EUR_per_litre: 1.35, gas_EUR_per_MWh_th: 55,
  },
  SG_SINGAPORE: {
    label: "Singapore (hot-humid, AIDC reference)", country: "SG", lat: 1.35,
    specificYield_kWh_per_kWp: 1250,
    monthlyYieldShare: [8.2, 8.8, 9.0, 8.6, 8.4, 8.3, 8.4, 8.4, 8.3, 8.2, 7.6, 7.8],
    tempMeanC: [27, 28, 28, 28, 28, 28, 28, 28, 28, 28, 27, 27],
    diurnalSwingC: 6,
    windMean_m_s_100m: 4.0, weibullK: 1.8,
    gridCO2_g_per_kWh: 400, importTariff_EUR_per_MWh: 135, gridFee_EUR_per_MWh: 25,
    capacityCharge_EUR_per_kW_yr: 40, diesel_EUR_per_litre: 1.10, gas_EUR_per_MWh_th: 30,
  },
  CUSTOM_SITE: {
    label: "Custom site — enter your own data", country: "OTHER", lat: 45.0,
    specificYield_kWh_per_kWp: 1200,
    monthlyYieldShare: [3.5, 5.0, 7.8, 10.0, 12.0, 12.6, 13.0, 11.8, 9.2, 6.5, 4.2, 3.4],
    tempMeanC: [4, 5, 9, 12, 16, 20, 22, 22, 18, 13, 8, 5],
    diurnalSwingC: 9,
    windMean_m_s_100m: 6.5, weibullK: 2.0,
    gridCO2_g_per_kWh: 250, importTariff_EUR_per_MWh: 100, gridFee_EUR_per_MWh: 30,
    capacityCharge_EUR_per_kW_yr: 50, diesel_EUR_per_litre: 1.30, gas_EUR_per_MWh_th: 45,
  },
  REMOTE_ISLAND: {
    label: "Tropical island / off-grid reference", country: "XX", lat: -21.10,
    specificYield_kWh_per_kWp: 1520,
    monthlyYieldShare: [9.8, 9.2, 9.0, 8.2, 7.2, 6.6, 6.8, 7.6, 8.4, 9.0, 9.2, 9.0],
    tempMeanC: [26, 27, 26, 25, 23, 21, 20, 20, 21, 23, 24, 25],
    diurnalSwingC: 7,
    windMean_m_s_100m: 7.0, weibullK: 2.0,
    gridCO2_g_per_kWh: 700, importTariff_EUR_per_MWh: 220, gridFee_EUR_per_MWh: 0,
    capacityCharge_EUR_per_kW_yr: 0, diesel_EUR_per_litre: 1.65, gas_EUR_per_MWh_th: 90,
  },
};

/* ============================================================================
   LOAD SHAPE LIBRARY — 24 hourly factors, weekday and weekend, range 0…1.
   These are shapes only; magnitude comes from base / peak / annual energy.
   ========================================================================== */

/* ============================================================================
   WHOLESALE MARKET PRICE REFERENCE — calendar year 2025
   Annual day-ahead averages as published by the market operators. The monthly
   and hourly shapes are typical Central-European patterns, scaled so the
   annual mean matches the published figure. Indicative only: use your own
   hourly series where the answer depends on it.
   ========================================================================== */

export const MARKET_PRICES_2025 = {
  FR: { label: "France — EPEX FR", annualAvg_EUR_per_MWh: 61, source: "RTE annual review 2025 (about €4/MWh below Spain)" },
  NL: { label: "Netherlands — EPEX NL", annualAvg_EUR_per_MWh: 87, source: "TenneT Annual Market Update 2025 (€86.8/MWh, +12 % on 2024)" },
  DE: { label: "Germany — EPEX DE-LU", annualAvg_EUR_per_MWh: 90, source: "ENTSO-E day-ahead, 2025 average €89.9/MWh (+14 % on 2024)" },
  ES: { label: "Spain — OMIE", annualAvg_EUR_per_MWh: 65, source: "Red Eléctrica system report 2025 (€65.29/MWh, +3.6 % on 2024)" },
  UK: { label: "United Kingdom — N2EX", annualAvg_EUR_per_MWh: 105, source: "IEA Electricity 2026; UK wholesale rose ~40 % in H1 2025" },
  OTHER: { label: "Generic — scaled to the site tariff", annualAvg_EUR_per_MWh: null, source: "no published 2025 curve for this market; the site tariff is used as the annual mean" },
};

/* National electricity DEMAND shape — the starting point for the price model.
   Winter-weighted, morning ramp, evening peak, overnight trough. */
export const DEMAND_MONTHLY_INDEX = [1.15, 1.12, 1.05, 0.96, 0.90, 0.88, 0.88, 0.87, 0.92, 1.00, 1.08, 1.14];
export const DEMAND_HOURLY_INDEX = {
  weekday: [0.72, 0.68, 0.66, 0.65, 0.67, 0.73, 0.85, 0.95, 1.00, 1.00, 0.99, 0.98,
    0.96, 0.95, 0.94, 0.95, 1.00, 1.08, 1.10, 1.05, 0.98, 0.90, 0.82, 0.76],
  weekend: [0.68, 0.65, 0.63, 0.62, 0.63, 0.66, 0.72, 0.80, 0.87, 0.91, 0.93, 0.93,
    0.92, 0.91, 0.90, 0.91, 0.95, 1.02, 1.04, 1.00, 0.94, 0.87, 0.80, 0.73],
};

/* Share of national annual demand met by solar and by wind, 2025.
   These set how hard the price is pushed down when the resource is running —
   and they are what tie the price curve to the same weather the PV model uses. */
export const VRE_PENETRATION_2025 = {
  FR: { solar: 0.05, wind: 0.09 },
  NL: { solar: 0.20, wind: 0.26 },
  DE: { solar: 0.14, wind: 0.28 },
  ES: { solar: 0.22, wind: 0.23 },
  UK: { solar: 0.05, wind: 0.29 },
  OTHER: { solar: 0.08, wind: 0.10 },
};
