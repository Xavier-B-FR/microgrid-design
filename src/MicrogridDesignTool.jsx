import React, { useState, useMemo, useRef, useContext, createContext } from "react";
import Papa from "papaparse";
import {
  AreaChart, Area, LineChart, Line, BarChart, Bar, ComposedChart,
  XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer, ReferenceLine,
} from "recharts";

/* ============================================================================
   MICROGRID DESIGN TOOL — PHASE 1
   Project context · Location & resource library · Load input · AIDC derivation

   ALL physical and cost coefficients live in this block. Nothing numeric is
   buried in a function below. Units are stated on every single entry.
   ========================================================================== */

export const CONSTANTS = {
  /* --- Time base -------------------------------------------------------- */
  HOURS_PER_YEAR: 8760,                 // h/yr   non-leap reference year
  REFERENCE_YEAR: 2027,                 // -      non-leap; fixes weekday pattern
  DAYS_PER_MONTH: [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31], // d

  /* --- Solar geometry & clear-sky model ---------------------------------
     Shape only. Magnitude is anchored to the location's stated specific
     yield (kWh/kWp/yr), so the model never invents a resource.            */
  SOLAR_CONSTANT_W_M2: 1361,            // W/m²   extraterrestrial normal irradiance
  CLEARSKY_ATM_TRANSMITTANCE: 0.70,     // -      broadband transmittance at AM1 (Meinel form)
  CLEARSKY_AM_EXPONENT: 0.678,          // -      air-mass exponent, ghi = E0·cosθz·τ^(AM^x)
  MIN_COS_ZENITH: 0.02,                 // -      below this the hour is treated as dark
  PV_TILT_FRACTION_OF_LAT: 0.9,         // -      assumed fixed tilt = 0.9 × |latitude|
  PV_TILT_MAX_DEG: 40,                  // °      cap on the assumed fixed tilt

  /* --- PV cell thermal behaviour (used to shape the yield profile) ------- */
  PV_NOCT_C: 45,                        // °C     nominal operating cell temp @ 800 W/m², 20 °C
  PV_NOCT_IRRADIANCE_W_M2: 800,         // W/m²   reference irradiance for NOCT
  PV_NOCT_AMBIENT_C: 20,                // °C     reference ambient for NOCT
  PV_TEMP_COEFF_PCT_PER_C: -0.35,       // %/°C   Pmp coefficient above 25 °C
  PV_REF_TEMP_C: 25,                    // °C     STC cell temperature

  /* --- Resource data quality -------------------------------------------- */
  LIBRARY_YIELD_UNCERTAINTY_PCT: 8,     // ±%     P50 band on a library yield vs site data
  SITE_YIELD_UNCERTAINTY_PCT: 3,        // ±%     P50 band on an uploaded TMY / measured year

  /* --- Ambient temperature synthesis ------------------------------------ */
  DIURNAL_PEAK_HOUR: 15,                // h      hour of day of the daily temperature maximum

  /* --- AIDC: cooling system behaviour -----------------------------------
     designPUE     : default total PUE at the site design ambient
     freeCoolingBelowC : dry-bulb at or below which the plant is on economiser only
     designAmbientC: dry-bulb at which the design PUE is quoted
     minCoolingFrac: cooling power at full free cooling, as a fraction of design
                     cooling power (fans / pumps still run)
     overloadCap   : max cooling power above design ambient, fraction of design  */
  COOLING: {
    air:       { designPUE: 1.35, freeCoolingBelowC: 18, designAmbientC: 35, minCoolingFrac: 0.25, overloadCap: 1.15, label: "Air cooled (CRAH / economiser)" },
    liquid:    { designPUE: 1.20, freeCoolingBelowC: 22, designAmbientC: 35, minCoolingFrac: 0.18, overloadCap: 1.12, label: "Direct-to-chip liquid" },
    immersion: { designPUE: 1.10, freeCoolingBelowC: 30, designAmbientC: 40, minCoolingFrac: 0.10, overloadCap: 1.08, label: "Immersion" },
  },
  PUE_CLIMATE_ADDER_PER_C: 0.006,       // PUE/°C  added per °C of annual mean above 12 °C reference
  PUE_CLIMATE_REF_TEMP_C: 12,           // °C      reference annual mean for the adder
  PUE_CLIMATE_ADDER_MAX: 0.15,          // PUE     cap on the climate adder

  /* --- AIDC: non-cooling overhead (all as % of IT load) ------------------ */
  UPS_LOSS_PCT_OF_IT: 2.5,              // %       double-conversion UPS losses at part load
  DISTRIBUTION_LOSS_PCT_OF_IT: 1.5,     // %       transformers, switchgear, busway
  MISC_LOAD_PCT_OF_IT: 1.0,             // %       lighting, controls, security, offices

  /* --- AIDC: criticality and dynamics ----------------------------------- */
  IT_UTILISATION_PCT_DEFAULT: 85,       // %       mean IT draw vs installed IT capacity
  LIQUID_RACK_THERMAL_MARGIN_S: 15,     // s       time to thermal trip at high density with no flow
  AIR_RACK_THERMAL_MARGIN_S: 120,       // s       equivalent for a conventional air-cooled hall
  ANTI_RECYCLE_TIMER_MIN_DEFAULT: 10,   // min     chiller restart lockout after a stop
  LOAD_SWING_PCT_DEFAULT: 30,           // % of IT collective compute swing (training job start/stop)
  LOAD_SWING_SECONDS_DEFAULT: 2,        // s       timescale over which that swing occurs

  /* --- AIDC: redundancy → firm capacity requirement ---------------------- */
  REDUNDANCY: {
    N:      { firmFactor: 1.00, spareUnits: 0, label: "N (no redundancy)" },
    NPLUS1: { firmFactor: 1.00, spareUnits: 1, label: "N+1 (one spare unit)" },
    TWON:   { firmFactor: 2.00, spareUnits: 0, label: "2N (two independent paths)" },
  },

  /* --- Land and footprint ------------------------------------------------ */
  PV_AREA_M2_PER_KWP: 12,               // m²/kWp  ground-mount incl. row spacing, mid-latitude
  PV_AREA_M2_PER_KWP_ROOF: 7,           // m²/kWp  flat-roof ballasted
  BESS_FOOTPRINT_M2_PER_MW: 120,        // m²/MW   containerised, incl. access and separation
  ENGINE_FOOTPRINT_M2_PER_MW: 90,       // m²/MW   containerised gensets incl. radiators
  M2_PER_HA: 10000,                     // m²/ha

  /* --- Load synthesis ---------------------------------------------------- */
  SHAPE_GAMMA_MIN: 0.05,                // -       lower bound of the shape exponent search
  SHAPE_GAMMA_MAX: 25,                  // -       upper bound of the shape exponent search
  SHAPE_GAMMA_TOL_MWH: 0.05,            // MWh     bisection tolerance on annual energy

  /* --- Cost defaults library (EUR, EU markets) — surfaced in Phase 4 -----
     Held here so that every coefficient in the tool sits in one place.     */
  COST_DEFAULTS: {
    PV_EUR_PER_KWP: 650,                // €/kWp   ground-mount, EPC, ex-grid connection
    BESS_EUR_PER_KW: 180,               // €/kW    power conversion system
    BESS_EUR_PER_KWH: 190,              // €/kWh   LFP cells + enclosure + HVAC
    BESS_GRID_FORMING_ADDER_EUR_PER_KW: 25, // €/kW additional for grid-forming capability
    ENGINE_DIESEL_EUR_PER_KW: 420,      // €/kW    containerised genset, installed
    ENGINE_GAS_EUR_PER_KW: 780,         // €/kW    gas reciprocating engine, installed
    TURBINE_EUR_PER_KW: 950,            // €/kW    aeroderivative gas turbine, installed
    WIND_EUR_PER_KW: 1350,              // €/kW    onshore, installed
    GRID_CONNECTION_EUR_PER_KW: 120,    // €/kW    typical HV connection charge, EU average
    OM_PV_EUR_PER_KWP_YR: 12,           // €/kWp/yr
    OM_BESS_PCT_CAPEX_YR: 1.5,          // %/yr    of BESS capex
    OM_ENGINE_EUR_PER_RUN_HOUR_PER_MW: 9, // €/MW/running hour
    OM_WIND_EUR_PER_KW_YR: 38,          // €/kW/yr
    BESS_AUGMENTATION_EUR_PER_KWH: 110, // €/kWh   at augmentation year, real terms
    DIESEL_KWH_PER_LITRE: 10.0,         // kWh_th/l  lower heating value of diesel
    CO2_KG_PER_LITRE_DIESEL: 2.68,      // kgCO2/l
    CO2_KG_PER_MWH_GAS: 202,            // kgCO2/MWh_th  natural gas combustion
  },
};

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

export const LOAD_SHAPES = {
  continuous: {
    label: "Continuous 24/7 process",
    weekday: [0.90,0.90,0.89,0.89,0.90,0.92,0.95,0.98,1.00,1.00,1.00,1.00,0.99,0.99,1.00,1.00,0.99,0.97,0.95,0.94,0.93,0.92,0.91,0.90],
    weekend: [0.88,0.88,0.87,0.87,0.88,0.89,0.91,0.93,0.95,0.96,0.96,0.96,0.95,0.95,0.95,0.95,0.94,0.93,0.92,0.91,0.90,0.89,0.89,0.88],
  },
  datacentre: {
    label: "Data centre (flat)",
    weekday: [0.96,0.96,0.95,0.95,0.95,0.96,0.97,0.98,0.99,1.00,1.00,1.00,1.00,1.00,1.00,1.00,0.99,0.99,0.98,0.98,0.97,0.97,0.96,0.96],
    weekend: [0.95,0.95,0.94,0.94,0.94,0.95,0.96,0.97,0.98,0.98,0.99,0.99,0.99,0.99,0.99,0.98,0.98,0.98,0.97,0.97,0.96,0.96,0.95,0.95],
  },
  single_shift: {
    label: "Single shift (06:00–14:00)",
    weekday: [0.08,0.08,0.08,0.08,0.10,0.35,0.75,0.95,1.00,1.00,0.98,0.98,0.95,0.90,0.60,0.20,0.12,0.10,0.09,0.08,0.08,0.08,0.08,0.08],
    weekend: [0.08,0.08,0.08,0.08,0.08,0.09,0.10,0.12,0.14,0.14,0.14,0.14,0.13,0.12,0.11,0.10,0.09,0.09,0.08,0.08,0.08,0.08,0.08,0.08],
  },
  two_shift: {
    label: "Two shift (06:00–22:00)",
    weekday: [0.18,0.17,0.17,0.17,0.20,0.45,0.85,1.00,1.00,0.98,0.97,0.95,0.88,0.92,0.97,0.98,0.97,0.95,0.90,0.80,0.60,0.35,0.22,0.19],
    weekend: [0.16,0.16,0.15,0.15,0.16,0.20,0.28,0.32,0.34,0.34,0.33,0.32,0.30,0.30,0.30,0.29,0.28,0.26,0.24,0.22,0.20,0.18,0.17,0.16],
  },
  office: {
    label: "Office hours",
    weekday: [0.12,0.12,0.11,0.11,0.12,0.15,0.28,0.55,0.85,0.95,1.00,1.00,0.92,0.95,0.98,0.96,0.88,0.65,0.42,0.28,0.20,0.16,0.14,0.13],
    weekend: [0.12,0.12,0.11,0.11,0.11,0.12,0.13,0.15,0.18,0.20,0.21,0.21,0.20,0.20,0.19,0.18,0.17,0.16,0.15,0.14,0.13,0.13,0.12,0.12],
  },
  custom: {
    label: "Custom weekday / weekend",
    weekday: new Array(24).fill(0.8),
    weekend: new Array(24).fill(0.5),
  },
};

export const USE_CASE_FAMILIES = {
  resilience:   { label: "Resilience driven",            binding: "Power + dynamic adequacy in island mode", defaults: { islanding: "unplanned", autonomyH: 8,  critPct: 70 } },
  cost:         { label: "Cost / self-consumption",      binding: "Energy cost — tariff and demand charges", defaults: { islanding: "none",      autonomyH: 0,  critPct: 30 } },
  access:       { label: "Access (off-grid, island)",    binding: "Energy adequacy — unserved energy",       defaults: { islanding: "unplanned", autonomyH: 24, critPct: 90 } },
  decarb:       { label: "Decarbonisation",              binding: "Renewable fraction at acceptable LCOE",   defaults: { islanding: "none",      autonomyH: 0,  critPct: 40 } },
  deferral:     { label: "Grid connection deferral",     binding: "Firm capacity behind an import cap",      defaults: { islanding: "planned",   autonomyH: 4,  critPct: 85 } },
};

/* ============================================================================
   ENGINE — calendar, ambient temperature, solar resource, load synthesis
   ========================================================================== */

const H = CONSTANTS.HOURS_PER_YEAR;

function buildCalendar() {
  const month = new Uint8Array(H), hourOfDay = new Uint8Array(H);
  const doy = new Uint16Array(H), dow = new Uint8Array(H);
  let i = 0, day = 0;
  for (let m = 0; m < 12; m++) {
    for (let d = 0; d < CONSTANTS.DAYS_PER_MONTH[m]; d++) {
      const w = new Date(Date.UTC(CONSTANTS.REFERENCE_YEAR, m, d + 1)).getUTCDay();
      for (let h = 0; h < 24; h++) { month[i] = m; hourOfDay[i] = h; doy[i] = day; dow[i] = w; i++; }
      day++;
    }
  }
  return { month, hourOfDay, doy, dow };
}

/** Cyclic linear interpolation of 12 monthly values onto 365 days, anchored at month mid-points. */
function monthlyToDaily(monthly) {
  const mid = []; let acc = 0;
  for (let m = 0; m < 12; m++) { mid.push(acc + CONSTANTS.DAYS_PER_MONTH[m] / 2); acc += CONSTANTS.DAYS_PER_MONTH[m]; }
  const out = new Float32Array(365);
  for (let d = 0; d < 365; d++) {
    let m1 = 11, m2 = 0, f = 0;
    if (d < mid[0]) { m1 = 11; m2 = 0; f = (d + 365 - mid[11]) / (mid[0] + 365 - mid[11]); }
    else if (d >= mid[11]) { m1 = 11; m2 = 0; f = (d - mid[11]) / (mid[0] + 365 - mid[11]); }
    else { for (let m = 0; m < 11; m++) if (d >= mid[m] && d < mid[m + 1]) { m1 = m; m2 = m + 1; f = (d - mid[m]) / (mid[m + 1] - mid[m]); break; } }
    out[d] = monthly[m1] * (1 - f) + monthly[m2] * f;
  }
  return out;
}

/** Hourly dry-bulb ambient (°C): monthly mean + sinusoidal diurnal swing peaking at 15:00. */
function buildTemperature(loc, cal) {
  const daily = monthlyToDaily(loc.tempMeanC);
  const swing = loc.diurnalSwingC;
  const T = new Float32Array(H);
  const phase = (CONSTANTS.DIURNAL_PEAK_HOUR - 6) / 24 * 2 * Math.PI;
  for (let i = 0; i < H; i++) {
    T[i] = daily[cal.doy[i]] + (swing / 2) * Math.sin(2 * Math.PI * cal.hourOfDay[i] / 24 - phase);
  }
  return T;
}

/**
 * Hourly PV specific production, kW per kWp installed.
 * Shape  = clear-sky geometry × monthly clearness × cell-temperature derate.
 * Scale  = anchored so that Σ = the stated annual specific yield (kWh/kWp/yr).
 * The model therefore never claims a resource the yield figure does not support.
 */
function buildPVUnit(loc, cal, temp) {
  const raw = new Float32Array(H);
  const phi = loc.lat * Math.PI / 180;
  // Fixed, equator-facing plane. Tilting the array is equivalent to shifting the
  // effective latitude toward the equator by the tilt angle.
  const tiltDeg = Math.min(CONSTANTS.PV_TILT_MAX_DEG, Math.abs(loc.lat) * CONSTANTS.PV_TILT_FRACTION_OF_LAT);
  const phiEff = (loc.lat - Math.sign(loc.lat || 1) * tiltDeg) * Math.PI / 180;
  for (let i = 0; i < H; i++) {
    const n = cal.doy[i] + 1;
    const dec = 23.45 * Math.sin(2 * Math.PI * (284 + n) / 365) * Math.PI / 180;
    const omega = (cal.hourOfDay[i] + 0.5 - 12) * 15 * Math.PI / 180;
    const cosz = Math.sin(phi) * Math.sin(dec) + Math.cos(phi) * Math.cos(dec) * Math.cos(omega);
    if (cosz <= CONSTANTS.MIN_COS_ZENITH) { raw[i] = 0; continue; }
    const cosInc = Math.max(0, Math.sin(phiEff) * Math.sin(dec) + Math.cos(phiEff) * Math.cos(dec) * Math.cos(omega));
    const am = 1 / cosz;
    const ghi = CONSTANTS.SOLAR_CONSTANT_W_M2 * cosInc *
      Math.pow(CONSTANTS.CLEARSKY_ATM_TRANSMITTANCE, Math.pow(am, CONSTANTS.CLEARSKY_AM_EXPONENT));
    const tcell = temp[i] + (CONSTANTS.PV_NOCT_C - CONSTANTS.PV_NOCT_AMBIENT_C) *
      (ghi / CONSTANTS.PV_NOCT_IRRADIANCE_W_M2);
    const derate = 1 + CONSTANTS.PV_TEMP_COEFF_PCT_PER_C / 100 * (tcell - CONSTANTS.PV_REF_TEMP_C);
    raw[i] = Math.max(0, ghi * derate);
  }
  // Re-weight to the library's monthly distribution
  const shareSum = loc.monthlyYieldShare.reduce((a, b) => a + b, 0);
  const monthRaw = new Float64Array(12);
  for (let i = 0; i < H; i++) monthRaw[cal.month[i]] += raw[i];
  let rawTotal = 0;
  for (let m = 0; m < 12; m++) rawTotal += monthRaw[m];
  const kMonth = new Float64Array(12);
  for (let m = 0; m < 12; m++) {
    kMonth[m] = monthRaw[m] > 0 ? (loc.monthlyYieldShare[m] / shareSum) / (monthRaw[m] / rawTotal) : 0;
  }
  let total = 0;
  for (let i = 0; i < H; i++) { raw[i] *= kMonth[cal.month[i]]; total += raw[i]; }
  // Anchor magnitude to the stated specific yield
  const k = total > 0 ? loc.specificYield_kWh_per_kWp / total : 0;
  for (let i = 0; i < H; i++) raw[i] *= k;
  return raw;
}

/**
 * Parametric 8760 load synthesis, kW.
 *   load[h] = base + (peak − base) · shape01[h]^γ
 * shape01 is the normalised weekday/weekend/seasonal shape (max = 1, min = 0),
 * so peak and base are matched exactly by construction. γ is then solved by
 * bisection so that the annual energy matches the target. γ is reported.
 */
function synthesiseLoad(p) {
  const cal = p.cal;
  const shape = LOAD_SHAPES[p.shapeKey] || LOAD_SHAPES.continuous;
  const wd = p.shapeKey === "custom" ? p.customWeekday : shape.weekday;
  const we = p.shapeKey === "custom" ? p.customWeekend : shape.weekend;
  const raw = new Float32Array(H);
  const peakDay = p.seasonalPeak === "winter" ? 15 : p.seasonalPeak === "summer" ? 197 : -1;
  for (let i = 0; i < H; i++) {
    const isWeekend = cal.dow[i] === 0 || cal.dow[i] === 6;
    let v = (isWeekend ? we[cal.hourOfDay[i]] * p.weekendFactor : wd[cal.hourOfDay[i]]);
    if (peakDay >= 0) v *= 1 + (p.seasonality / 100) * Math.cos(2 * Math.PI * (cal.doy[i] - peakDay) / 365);
    raw[i] = Math.max(0, v);
  }
  let mn = Infinity, mx = -Infinity;
  for (let i = 0; i < H; i++) { if (raw[i] < mn) mn = raw[i]; if (raw[i] > mx) mx = raw[i]; }
  const span = mx - mn || 1;
  const s01 = new Float32Array(H);
  for (let i = 0; i < H; i++) s01[i] = (raw[i] - mn) / span;

  const targetMWh = p.annualEnergyMWh;
  const energyAt = (g) => { let e = 0; for (let i = 0; i < H; i++) e += p.baseKW + (p.peakKW - p.baseKW) * Math.pow(s01[i], g); return e / 1000; };
  const eMin = energyAt(CONSTANTS.SHAPE_GAMMA_MAX);
  const eMax = energyAt(CONSTANTS.SHAPE_GAMMA_MIN);
  let gamma = 1, clamped = null;
  if (targetMWh <= eMin) { gamma = CONSTANTS.SHAPE_GAMMA_MAX; clamped = "low"; }
  else if (targetMWh >= eMax) { gamma = CONSTANTS.SHAPE_GAMMA_MIN; clamped = "high"; }
  else {
    let lo = CONSTANTS.SHAPE_GAMMA_MIN, hi = CONSTANTS.SHAPE_GAMMA_MAX;
    for (let it = 0; it < 60; it++) {
      gamma = (lo + hi) / 2;
      const e = energyAt(gamma);
      if (Math.abs(e - targetMWh) < CONSTANTS.SHAPE_GAMMA_TOL_MWH) break;
      if (e > targetMWh) lo = gamma; else hi = gamma;
    }
  }
  const load = new Float32Array(H);
  for (let i = 0; i < H; i++) load[i] = p.baseKW + (p.peakKW - p.baseKW) * Math.pow(s01[i], gamma);
  return { load, gamma, clamped, feasibleMWh: [eMin, eMax] };
}

/**
 * AIDC facility load derivation for one ramp year.
 * Total = IT + cooling(T_ambient) + other, all kW.
 * Cooling power is a linear function of dry-bulb between the free-cooling
 * threshold and the design ambient, floored at the fan/pump fraction and
 * capped at the overload fraction.
 */
function deriveAIDCLoad(a, temp, mwIT) {
  const cool = CONSTANTS.COOLING[a.coolingType];
  const itKW = mwIT * 1000 * (a.itUtilisationPct / 100);
  const otherPct = (a.upsPresent ? CONSTANTS.UPS_LOSS_PCT_OF_IT : 0)
    + CONSTANTS.DISTRIBUTION_LOSS_PCT_OF_IT + CONSTANTS.MISC_LOAD_PCT_OF_IT;
  const otherKW = itKW * otherPct / 100;
  const coolingDesignKW = Math.max(0, itKW * (a.designPUE - 1) - otherKW);
  const tFree = a.freeCoolingBelowC, tDes = a.designAmbientC;
  const total = new Float32Array(H), coolArr = new Float32Array(H);
  let freeHours = 0, aboveDesignHours = 0;
  for (let i = 0; i < H; i++) {
    let f;
    if (temp[i] <= tFree) { f = cool.minCoolingFrac; freeHours++; }
    else {
      f = cool.minCoolingFrac + (1 - cool.minCoolingFrac) * (temp[i] - tFree) / Math.max(0.1, tDes - tFree);
      if (f > cool.overloadCap) f = cool.overloadCap;
      if (temp[i] > tDes) aboveDesignHours++;
    }
    coolArr[i] = coolingDesignKW * f;
    total[i] = itKW + coolArr[i] + otherKW;
  }
  let e = 0; for (let i = 0; i < H; i++) e += total[i];
  const annualisedPUE = itKW > 0 ? (e / H) / itKW : 0;
  // Load at the design condition (cooling at 100 % of design), which is the
  // basis for firm capacity. A typical meteorological year never reaches the
  // design ambient at a cool site, so the simulated peak must NOT be used to
  // size firm plant — it would undersize the design.
  const designConditionKW = itKW + coolingDesignKW + otherKW;
  return {
    load: total, cooling: coolArr, itKW, otherKW, coolingDesignKW, designConditionKW,
    annualisedPUE, freeHours, aboveDesignHours, otherPct,
  };
}

/* --- CSV load parsing ------------------------------------------------------ */

function parseLoadCSV(text) {
  const res = Papa.parse(text.trim(), { header: false, skipEmptyLines: true, dynamicTyping: false });
  let rows = res.data;
  const notes = [];
  if (!rows.length) return { error: "The file contains no rows." };

  // Header detection
  let headerRow = null;
  const first = rows[0].map((c) => String(c).trim());
  if (first.some((c) => isNaN(parseFloat(c)) && c.length)) { headerRow = first; rows = rows.slice(1); }

  // Column selection
  let tsCol = -1, valCol = -1;
  if (headerRow) {
    headerRow.forEach((h, i) => {
      const s = h.toLowerCase();
      if (tsCol < 0 && /time|date|stamp|hour|period/.test(s)) tsCol = i;
      if (valCol < 0 && /kw|kwh|mw|load|power|demand|value|consum/.test(s)) valCol = i;
    });
  }
  if (valCol < 0) valCol = rows[0].length > 1 ? 1 : 0;
  if (tsCol < 0 && rows[0].length > 1) tsCol = 0;
  notes.push(`Value column: ${headerRow ? headerRow[valCol] : `column ${valCol + 1}`}.`);

  // Extract
  const raw = [];
  let nonNumeric = 0;
  for (const r of rows) {
    const v = parseFloat(String(r[valCol]).replace(",", "."));
    if (isNaN(v)) { nonNumeric++; raw.push(null); } else raw.push(v);
  }
  if (nonNumeric) notes.push(`${nonNumeric} non-numeric value${nonNumeric > 1 ? "s" : ""} treated as gaps.`);

  // Interval detection by row count
  const n = raw.length;
  let stepsPerHour = 1, detected = "hourly";
  if (n >= 34000) { stepsPerHour = 4; detected = "15-minute"; }
  else if (n >= 17000) { stepsPerHour = 2; detected = "30-minute"; }
  notes.push(`${n} rows → interval detected as ${detected}.`);

  // Duplicate timestamps
  let dupes = 0;
  if (tsCol >= 0) {
    const seen = new Set(); const keep = [];
    for (let i = 0; i < rows.length; i++) {
      const k = String(rows[i][tsCol]).trim();
      if (k && seen.has(k)) { dupes++; continue; }
      if (k) seen.add(k);
      keep.push(raw[i]);
    }
    if (dupes) { raw.length = keep.length; for (let i = 0; i < keep.length; i++) raw[i] = keep[i]; notes.push(`${dupes} duplicated timestamp${dupes > 1 ? "s" : ""} dropped (first occurrence kept).`); }
  }

  // Aggregate to hourly
  const hourly = [];
  for (let i = 0; i < raw.length; i += stepsPerHour) {
    let s = 0, c = 0;
    for (let j = i; j < Math.min(i + stepsPerHour, raw.length); j++) if (raw[j] !== null) { s += raw[j]; c++; }
    hourly.push(c ? s / c : null);
  }

  // Leap year
  if (hourly.length === 8784) { hourly.splice(59 * 24, 24); notes.push("Leap year detected — 29 February removed."); }

  // Negatives
  let negs = 0;
  for (let i = 0; i < hourly.length; i++) if (hourly[i] !== null && hourly[i] < 0) { negs++; hourly[i] = 0; }
  if (negs) notes.push(`${negs} negative value${negs > 1 ? "s" : ""} clamped to 0 kW.`);

  // Gap filling — same hour of the adjacent day, else linear, else annual mean
  let gaps = 0;
  const valid = hourly.filter((v) => v !== null);
  const mean = valid.length ? valid.reduce((a, b) => a + b, 0) / valid.length : 0;
  for (let i = 0; i < hourly.length; i++) {
    if (hourly[i] === null) {
      gaps++;
      const prevDay = i - 24 >= 0 ? hourly[i - 24] : null;
      const nextDay = i + 24 < hourly.length ? hourly[i + 24] : null;
      if (prevDay !== null && prevDay !== undefined) hourly[i] = prevDay;
      else if (nextDay !== null && nextDay !== undefined) hourly[i] = nextDay;
      else hourly[i] = mean;
    }
  }
  if (gaps) notes.push(`${gaps} gap${gaps > 1 ? "s" : ""} filled from the same hour of the adjacent day.`);

  // Length
  let lengthNote = null;
  if (hourly.length > H) { lengthNote = `Series truncated from ${hourly.length} h to 8760 h.`; hourly.length = H; }
  else if (hourly.length < H) {
    lengthNote = `Series padded from ${hourly.length} h to 8760 h by repeating the last full week.`;
    const src = hourly.slice(-168).length ? hourly.slice(-168) : [mean];
    let k = 0; while (hourly.length < H) { hourly.push(src[k % src.length]); k++; }
  }
  if (lengthNote) notes.push(lengthNote);

  const arr = Float32Array.from(hourly);
  return { load: arr, notes, rowsIn: n, detected };
}

/* --- Statistics ------------------------------------------------------------ */

function loadStats(load, cal) {
  let e = 0, peak = -Infinity, min = Infinity, peakH = 0;
  for (let i = 0; i < H; i++) { e += load[i]; if (load[i] > peak) { peak = load[i]; peakH = i; } if (load[i] < min) min = load[i]; }
  const monthly = new Float64Array(12);
  for (let i = 0; i < H; i++) monthly[cal.month[i]] += load[i] / 1000;
  return {
    annualMWh: e / 1000, peakKW: peak, minKW: min, meanKW: e / H,
    loadFactor: peak > 0 ? (e / H) / peak : 0, peakHour: peakH, monthlyMWh: Array.from(monthly),
  };
}

function durationCurve(load, points = 200) {
  const sorted = Array.from(load).sort((a, b) => b - a);
  const out = [];
  for (let i = 0; i < points; i++) {
    const idx = Math.floor(i / (points - 1) * (H - 1));
    out.push({ pct: +(idx / (H - 1) * 100).toFixed(1), kW: +sorted[idx].toFixed(1) });
  }
  return out;
}

const MONTHS = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
const fmt = (v, d = 1) => (v === null || v === undefined || isNaN(v) ? "—" : Number(v).toLocaleString("en-GB", { minimumFractionDigits: d, maximumFractionDigits: d }));
function dayLabel(dayIndex) {
  let d = dayIndex, m = 0;
  while (d >= CONSTANTS.DAYS_PER_MONTH[m]) { d -= CONSTANTS.DAYS_PER_MONTH[m]; m++; }
  return `${d + 1} ${MONTHS[m]}`;
}

/* ============================================================================
   THEME
   Two palettes. Tailwind's dark: variant needs a build-config change, so the
   palette is resolved in JS instead and passed down through context. Every
   colour in the UI comes from here — no colour class is written inline.
   ========================================================================== */

export const THEMES = {
  dark: {
    key: "dark",
    app: "bg-slate-950 text-slate-200",
    panel: "border-slate-800 bg-slate-900",
    rule: "border-slate-800",
    tile: "border-slate-800 bg-slate-950",
    input: "border-slate-700 bg-slate-950 text-slate-100 focus:border-cyan-500",
    micro: "border-slate-800 bg-slate-950 text-slate-300",
    title: "text-slate-50",
    muted: "text-slate-400",
    faint: "text-slate-500",
    ghost: "text-slate-600",
    divide: "divide-slate-900",
    btn: "border-slate-700 bg-slate-900 text-slate-400",
    btnOn: "bg-cyan-900 text-cyan-200",
    chip: "border-cyan-800 bg-cyan-950 text-cyan-300",
    chipWarn: "bg-amber-950 text-amber-300",
    chipOk: "bg-emerald-950 text-emerald-300",
    chipIdle: "border-slate-800 bg-slate-900 text-slate-600",
    notice: {
      warn: "border-amber-700 bg-amber-950 text-amber-200",
      info: "border-slate-700 bg-slate-950 text-slate-300",
      fail: "border-rose-700 bg-rose-950 text-rose-200",
    },
    tone: { slate: "text-slate-100", cyan: "text-cyan-300", amber: "text-amber-300", emerald: "text-emerald-300", rose: "text-rose-300", violet: "text-violet-300" },
    critRule: "border-cyan-600",
    critLabel: "text-slate-100",
    advLabel: "text-slate-500",
    chart: { grid: "#1e293b", axis: "#475569", tipBg: "#020617", tipBorder: "#1e293b", load: "#22d3ee", loadFill: "#0e7490", temp: "#f59e0b", pv: "#a78bfa", bar1: "#0e7490", bar2: "#f59e0b", ref: "#64748b", refWarn: "#f43f5e" },
  },
  light: {
    key: "light",
    app: "bg-slate-100 text-slate-800",
    panel: "border-slate-300 bg-white",
    rule: "border-slate-200",
    tile: "border-slate-200 bg-slate-50",
    input: "border-slate-300 bg-white text-slate-900 focus:border-cyan-600",
    micro: "border-slate-200 bg-white text-slate-700",
    title: "text-slate-900",
    muted: "text-slate-600",
    faint: "text-slate-500",
    ghost: "text-slate-400",
    divide: "divide-slate-100",
    btn: "border-slate-300 bg-white text-slate-600",
    btnOn: "bg-cyan-700 text-white",
    chip: "border-cyan-300 bg-cyan-50 text-cyan-800",
    chipWarn: "bg-amber-100 text-amber-800",
    chipOk: "bg-emerald-100 text-emerald-800",
    chipIdle: "border-slate-200 bg-slate-50 text-slate-400",
    notice: {
      warn: "border-amber-300 bg-amber-50 text-amber-900",
      info: "border-slate-300 bg-slate-50 text-slate-700",
      fail: "border-rose-300 bg-rose-50 text-rose-900",
    },
    tone: { slate: "text-slate-900", cyan: "text-cyan-700", amber: "text-amber-700", emerald: "text-emerald-700", rose: "text-rose-700", violet: "text-violet-700" },
    critRule: "border-cyan-600",
    critLabel: "text-slate-900",
    advLabel: "text-slate-500",
    chart: { grid: "#e2e8f0", axis: "#64748b", tipBg: "#ffffff", tipBorder: "#cbd5e1", load: "#0891b2", loadFill: "#a5f3fc", temp: "#d97706", pv: "#7c3aed", bar1: "#0891b2", bar2: "#f59e0b", ref: "#94a3b8", refWarn: "#e11d48" },
  },
};

const ThemeCtx = createContext(THEMES.dark);
const useT = () => useContext(ThemeCtx);

/* ============================================================================
   UI PRIMITIVES
   Input tiers:
     critical — must be set and checked; carries a rule and a bright label
     advanced — has a defensible default; dimmed, and folded away by default
   ========================================================================== */

function Panel({ title, step, right, children, sub }) {
  const T = useT();
  return (
    <section className={`rounded border ${T.panel}`}>
      <header className={`flex items-center justify-between gap-3 border-b px-3 py-2 ${T.rule}`}>
        <div className="flex items-baseline gap-2 min-w-0">
          {step && <span className={`font-mono text-xs shrink-0 ${T.tone.cyan}`}>{step}</span>}
          <h2 className={`text-sm font-semibold truncate ${T.title}`}>{title}</h2>
          {sub && <span className={`text-xs truncate hidden sm:inline ${T.faint}`}>{sub}</span>}
        </div>
        <div className="shrink-0">{right}</div>
      </header>
      <div className="p-3">{children}</div>
    </section>
  );
}

function Field({ label, unit, children, hint, flag, tier = "advanced" }) {
  const T = useT();
  const crit = tier === "critical";
  return (
    <label className={`block border-l-2 pl-2 ${crit ? T.critRule : "border-transparent"}`}>
      <div className="flex items-baseline justify-between gap-2">
        <span className={`text-xs ${crit ? `font-medium ${T.critLabel}` : T.advLabel}`}>{label}</span>
        <span className={`font-mono text-xs ${T.ghost}`}>{unit}</span>
      </div>
      {children}
      {hint && <div className={`mt-0.5 text-xs ${T.faint}`}>{hint}</div>}
      {flag && <div className={`mt-0.5 font-mono text-xs ${T.tone.amber}`}>{flag}</div>}
    </label>
  );
}

const inpCls = (T) => `mt-0.5 w-full rounded border px-2 py-1 font-mono text-sm focus:outline-none ${T.input}`;

function Num({ value, onChange, step = 1, min, max, disabled }) {
  const T = useT();
  return (
    <input type="number" className={inpCls(T)} value={value === "" || value === null ? "" : value}
      step={step} min={min} max={max} disabled={disabled}
      onChange={(e) => onChange(e.target.value === "" ? "" : Number(e.target.value))} />
  );
}

function Txt({ value, onChange, placeholder, readOnly }) {
  const T = useT();
  return <input className={inpCls(T)} value={value} placeholder={placeholder} readOnly={readOnly}
    onChange={onChange ? (e) => onChange(e.target.value) : undefined} />;
}

function Sel({ value, onChange, options, disabled }) {
  const T = useT();
  return (
    <select className={inpCls(T)} value={value} disabled={disabled} onChange={(e) => onChange(e.target.value)}>
      {options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
    </select>
  );
}

/** A folded group of advanced parameters. Remounted when the global density
 *  switch changes, so "Show every parameter" opens all of them at once. */
function Advanced({ title, count, defaultOpen, children }) {
  const T = useT();
  const [open, setOpen] = useState(!!defaultOpen);
  return (
    <div className={`mt-3 rounded border ${T.tile}`}>
      <button onClick={() => setOpen(!open)} className="flex w-full items-center justify-between gap-2 px-2 py-1.5">
        <span className={`text-xs uppercase tracking-wide ${T.faint}`}>
          <span className="font-mono mr-1">{open ? "−" : "+"}</span>{title}
        </span>
        <span className={`font-mono text-xs ${T.ghost}`}>{count} parameter{count === 1 ? "" : "s"} on default</span>
      </button>
      {open && <div className={`border-t p-2 ${T.rule}`}>{children}</div>}
    </div>
  );
}

function Stat({ label, value, unit, tone = "slate" }) {
  const T = useT();
  return (
    <div className={`rounded border px-2 py-1.5 ${T.tile}`}>
      <div className={`text-xs truncate ${T.faint}`}>{label}</div>
      <div className={`font-mono text-sm ${T.tone[tone]}`}>{value} <span className={`text-xs ${T.ghost}`}>{unit}</span></div>
    </div>
  );
}

/** The derivation trace: every computed number shown as the equation that produced it. */
function Trace({ lines }) {
  const T = useT();
  return (
    <div className={`rounded border ${T.tile}`}>
      <div className={`border-b px-2 py-1 text-xs uppercase tracking-wide ${T.rule} ${T.faint}`}>Derivation trace</div>
      <div className={`divide-y ${T.divide}`}>
        {lines.map((l, i) => (
          <div key={i} className="flex flex-wrap items-baseline gap-x-2 px-2 py-1">
            <span className={`w-40 shrink-0 text-xs ${T.faint}`}>{l.label}</span>
            <span className={`font-mono text-xs ${T.muted}`}>{l.expr}</span>
            <span className={`ml-auto font-mono text-xs ${T.tone.cyan}`}>{l.result}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function Notices({ items }) {
  const T = useT();
  if (!items.length) return null;
  return (
    <div className="space-y-1">
      {items.map((n, i) => (
        <div key={i} className={`rounded border px-2 py-1 text-xs ${T.notice[n.level]}`}>
          <span className="font-mono uppercase mr-2">{n.level === "warn" ? "check" : n.level === "fail" ? "blocker" : "note"}</span>{n.text}
        </div>
      ))}
    </div>
  );
}

function Seg({ value, onChange, options }) {
  const T = useT();
  return (
    <div className={`flex overflow-hidden rounded border ${T.btn}`}>
      {options.map((o) => (
        <button key={o.value} onClick={() => onChange(o.value)}
          className={`px-2 py-1 text-xs ${value === o.value ? T.btnOn : ""}`}>{o.label}</button>
      ))}
    </div>
  );
}

const PHASES = [
  { n: 1, label: "Context · resource · load", done: true },
  { n: 2, label: "Resources · dispatch engine", done: false },
  { n: 3, label: "Adequacy · BOM", done: false },
  { n: 4, label: "Costs · LCOE", done: false },
  { n: 5, label: "Auto-size · AIDC ramp", done: false },
  { n: 6, label: "Financials · scenarios · Excel", done: false },
];

/* ============================================================================
   APP
   ========================================================================== */

export default function MicrogridDesignTool() {
  const cal = useMemo(() => buildCalendar(), []);
  const fileRef = useRef(null);
  const resFileRef = useRef(null);

  const [themeKey, setThemeKey] = useState("dark");
  const T = THEMES[themeKey];
  const [density, setDensity] = useState("essential"); // "essential" | "full"
  const showAll = density === "full";

  const [mode, setMode] = useState("aidc"); // "standard" | "aidc"

  const [ctx, setCtx] = useState({
    useCase: "deferral", gridStatus: "firm", importCapKW: 8000, exportCapKW: 0,
    flexPctHours: 20, flexReducedCapKW: 4000,
    phases: [{ year: 1, capKW: 8000 }, { year: 3, capKW: 20000 }],
    islanding: "planned", autonomyH: 4, locationId: "FR_PARIS", lifeYears: 20, discountPct: 7,
  });

  const [locOverride, setLocOverride] = useState({});
  const [resourceSource, setResourceSource] = useState({ pv: "library", temp: "library", note: null });
  const [uploadedResource, setUploadedResource] = useState(null);

  const [aidc, setAidc] = useState({
    targetMWIT: 20,
    ramp: [{ year: 1, mwIT: 4 }, { year: 2, mwIT: 12 }, { year: 3, mwIT: 20 }],
    analysisYear: 3,
    coolingType: "liquid", designPUE: 1.20,
    freeCoolingBelowC: CONSTANTS.COOLING.liquid.freeCoolingBelowC,
    designAmbientC: CONSTANTS.COOLING.liquid.designAmbientC,
    itUtilisationPct: CONSTANTS.IT_UTILISATION_PCT_DEFAULT,
    redundancy: "NPLUS1", topology: "Dual radial, single EMS",
    upsPresent: true, upsAutonomyMin: 5,
    loadSwingPct: CONSTANTS.LOAD_SWING_PCT_DEFAULT,
    loadSwingSeconds: CONSTANTS.LOAD_SWING_SECONDS_DEFAULT,
    antiRecycleMin: CONSTANTS.ANTI_RECYCLE_TIMER_MIN_DEFAULT,
    landPV_ha: 12, pvAreaPerKWp: CONSTANTS.PV_AREA_M2_PER_KWP,
    landBESS_m2: 6000, bessFootprint: CONSTANTS.BESS_FOOTPRINT_M2_PER_MW,
    landEngine_m2: 5000, engineFootprint: CONSTANTS.ENGINE_FOOTPRINT_M2_PER_MW,
    gridStrategy: "capped", engineHoursLimit: 500, noiseLimitNote: "", waterAvailable: false,
    pueTouched: false,
  });

  const [loadCfg, setLoadCfg] = useState({
    path: "parametric", annualEnergyMWh: 12000, peakKW: 3000, baseKW: 400,
    shapeKey: "two_shift", seasonality: 12, seasonalPeak: "winter", weekendFactor: 1.0,
    customWeekday: [...LOAD_SHAPES.custom.weekday], customWeekend: [...LOAD_SHAPES.custom.weekend],
  });
  const [csvResult, setCsvResult] = useState(null);

  const [char, setChar] = useState({
    critPct: 85, shed1Pct: 10, shed2Pct: 5,
    stepKW: 800, motorKW: 400, motorMethod: "VSD",
    parasiticMode: "pct", parasiticPct: 5, parasiticKW: 0, touched: false,
  });

  const [view, setView] = useState({ span: "week", startDay: 172 });

  /* --- Derived ------------------------------------------------------------ */
  const loc = useMemo(() => ({ ...LOCATION_LIBRARY[ctx.locationId], ...locOverride }), [ctx.locationId, locOverride]);
  const temp = useMemo(() => uploadedResource?.temp || buildTemperature(loc, cal), [loc, cal, uploadedResource]);
  const pvUnit = useMemo(() => uploadedResource?.pvUnit || buildPVUnit(loc, cal, temp), [loc, cal, temp, uploadedResource]);
  const annualMeanT = useMemo(() => { let s = 0; for (let i = 0; i < H; i++) s += temp[i]; return s / H; }, [temp]);

  const aidcYearMW = useMemo(() => {
    const r = aidc.ramp.find((x) => x.year === aidc.analysisYear);
    return r ? r.mwIT : aidc.targetMWIT;
  }, [aidc]);

  const aidcDerived = useMemo(() => (mode === "aidc" ? deriveAIDCLoad(aidc, temp, aidcYearMW) : null), [mode, aidc, temp, aidcYearMW]);
  const synth = useMemo(() => (mode === "standard" && loadCfg.path === "parametric" ? synthesiseLoad({ ...loadCfg, cal }) : null), [mode, loadCfg, cal]);

  const load = useMemo(() => {
    if (mode === "aidc") return aidcDerived.load;
    if (loadCfg.path === "csv" && csvResult?.load) return csvResult.load;
    return synth ? synth.load : new Float32Array(H);
  }, [mode, aidcDerived, loadCfg.path, csvResult, synth]);

  const stats = useMemo(() => loadStats(load, cal), [load, cal]);
  const ldc = useMemo(() => durationCurve(load), [load]);

  const loadSource = useMemo(() => {
    if (mode === "aidc") return { kind: "Derived", text: `AIDC model · year ${aidc.analysisYear} · ${fmt(aidcYearMW, 1)} MW IT · annualised PUE ${fmt(aidcDerived.annualisedPUE, 3)}` };
    if (loadCfg.path === "csv" && csvResult?.load) return { kind: "Measured", text: `Uploaded CSV · ${csvResult.rowsIn} rows · ${csvResult.detected} → 8760 h` };
    if (loadCfg.path === "csv") return { kind: "Missing", text: "No CSV loaded yet — upload a file or switch to parametric synthesis" };
    return { kind: "Synthetic", text: `Parametric synthesis · ${LOAD_SHAPES[loadCfg.shapeKey].label} · shape exponent γ = ${fmt(synth?.gamma, 3)}` };
  }, [mode, loadCfg, csvResult, synth, aidc.analysisYear, aidcYearMW, aidcDerived]);

  const aidcOut = useMemo(() => {
    if (mode !== "aidc" || !aidcDerived) return null;
    const red = CONSTANTS.REDUNDANCY[aidc.redundancy];
    const peakMW = stats.peakKW / 1000;
    const designPeakMW = aidcDerived.designConditionKW / 1000;
    const sizingBasisMW = Math.max(peakMW, designPeakMW);
    const firmMW = sizingBasisMW * red.firmFactor;
    const stepKW = aidcDerived.itKW * (aidc.loadSwingPct / 100);
    const maxKWp = (aidc.landPV_ha * CONSTANTS.M2_PER_HA) / aidc.pvAreaPerKWp;
    const maxBessMW = aidc.landBESS_m2 / aidc.bessFootprint;
    const maxEngineMW = aidc.landEngine_m2 / aidc.engineFootprint;
    const critPct = 100 * (aidcDerived.itKW + aidcDerived.coolingDesignKW * 0.6) / (stats.meanKW || 1);
    return { red, peakMW, designPeakMW, sizingBasisMW, firmMW, stepKW, maxKWp, maxBessMW, maxEngineMW, critPct: Math.min(99, critPct) };
  }, [mode, aidc, aidcDerived, stats]);

  const notices = useMemo(() => {
    const n = [];
    if (resourceSource.pv === "library") {
      n.push({ level: "warn", text: `Specific yield ${fmt(loc.specificYield_kWh_per_kWp, 0)} kWh/kWp is a library default for ${loc.label}, not site data. Uncertainty band ±${CONSTANTS.LIBRARY_YIELD_UNCERTAINTY_PCT}%. Two bidders' LCOEs usually differ because their yield assumptions differ, not their equipment.` });
    }
    if (mode === "standard") {
      const sum = char.critPct + char.shed1Pct + char.shed2Pct;
      if (Math.abs(sum - 100) > 0.5) n.push({ level: "warn", text: `Criticality split sums to ${fmt(sum, 1)} %, not 100 %.` });
      if (synth?.clamped === "low") n.push({ level: "warn", text: `Annual energy ${fmt(loadCfg.annualEnergyMWh, 0)} MWh is below what this shape can produce with a ${fmt(loadCfg.baseKW, 0)} kW base load (minimum ≈ ${fmt(synth.feasibleMWh[0], 0)} MWh). Reduce the base load or raise the annual energy.` });
      if (synth?.clamped === "high") n.push({ level: "warn", text: `Annual energy ${fmt(loadCfg.annualEnergyMWh, 0)} MWh exceeds what a ${fmt(loadCfg.peakKW, 0)} kW peak can deliver on this shape (maximum ≈ ${fmt(synth.feasibleMWh[1], 0)} MWh). Raise the peak or lower the annual energy.` });
      if (loadCfg.baseKW >= loadCfg.peakKW) n.push({ level: "warn", text: "Base load is at or above peak demand — the profile will be flat." });
      if (char.stepKW > stats.peakKW * 0.5) n.push({ level: "warn", text: `Largest load step ${fmt(char.stepKW, 0)} kW is over half the site peak. Expect the dynamic adequacy check to govern the design.` });
    }
    if (mode === "aidc" && aidcOut) {
      const yr1 = aidc.ramp[0];
      if (yr1 && aidc.targetMWIT > 0 && yr1.mwIT / aidc.targetMWIT < 0.4) {
        n.push({ level: "warn", text: `Day-one load is ${fmt(100 * yr1.mwIT / aidc.targetMWIT, 0)} % of design. Any thermal plant sized for ${fmt(aidc.targetMWIT, 0)} MW IT will sit below minimum stable load in year ${yr1.year} — the phased build-out check in Phase 5 will confirm this.` });
      }
      if (aidc.coolingType !== "air") {
        n.push({ level: "info", text: `Liquid-cooled racks have ~${CONSTANTS.LIQUID_RACK_THERMAL_MARGIN_S} s of thermal margin with no coolant flow, against ~${CONSTANTS.AIR_RACK_THERMAL_MARGIN_S} s for an air-cooled hall. Cooling is not a sheddable load and the UPS does not back it unless it is explicitly on UPS.` });
      }
      if (aidc.redundancy === "TWON" && /single/i.test(aidc.topology)) {
        n.push({ level: "warn", text: "2N declared but the topology description mentions a single shared element. A single EMS, controller or storage system sitting across both paths defeats the redundancy. Full check in Phase 5." });
      }
      if (aidcDerived.aboveDesignHours > 0) {
        n.push({ level: "warn", text: `${aidcDerived.aboveDesignHours} h/yr above the ${fmt(aidc.designAmbientC, 0)} °C design ambient. Cooling power is extrapolated to a maximum of ${fmt(CONSTANTS.COOLING[aidc.coolingType].overloadCap * 100, 0)} % of design in those hours.` });
      }
      if (aidcOut.designPeakMW > aidcOut.peakMW * 1.02) {
        n.push({ level: "info", text: `Firm capacity is sized on the ${fmt(aidcOut.designPeakMW, 2)} MW design-ambient load, not the ${fmt(aidcOut.peakMW, 2)} MW peak of the typical year. A typical year never reaches the design ambient at this site — sizing on it would undersize the plant.` });
      }
      if (aidc.gridStrategy === "capped" && ctx.importCapKW < stats.peakKW) {
        n.push({ level: "info", text: `Import cap ${fmt(ctx.importCapKW / 1000, 1)} MW is below the ${fmt(stats.peakKW / 1000, 1)} MW facility peak. On-site generation must cover ${fmt((stats.peakKW - ctx.importCapKW) / 1000, 1)} MW at coincident peak.` });
      }
    }
    return n;
  }, [resourceSource, loc, mode, char, synth, loadCfg, stats, aidc, aidcOut, aidcDerived, ctx.importCapKW]);

  const series = useMemo(() => {
    const out = [];
    if (view.span === "year") {
      for (let d = 0; d < 365; d++) {
        let s = 0, t = 0, pv = 0;
        for (let h = 0; h < 24; h++) { const i = d * 24 + h; s += load[i]; t += temp[i]; pv += pvUnit[i]; }
        out.push({ t: dayLabel(d), load: +(s / 24).toFixed(1), temp: +(t / 24).toFixed(1), pv: +pv.toFixed(2) });
      }
      return out;
    }
    const days = view.span === "day" ? 1 : view.span === "week" ? 7 : 30;
    const start = view.startDay * 24;
    for (let k = 0; k < days * 24; k++) {
      const i = (start + k) % H;
      out.push({
        t: days === 1 ? `${String(cal.hourOfDay[i]).padStart(2, "0")}:00` : `${dayLabel(cal.doy[i])} ${String(cal.hourOfDay[i]).padStart(2, "0")}h`,
        load: +load[i].toFixed(1), temp: +temp[i].toFixed(1), pv: +pvUnit[i].toFixed(3),
      });
    }
    return out;
  }, [view, load, temp, pvUnit, cal]);

  const monthlyChart = useMemo(() => stats.monthlyMWh.map((v, i) => ({
    m: MONTHS[i], load: +v.toFixed(0),
    yield: +(loc.monthlyYieldShare[i] / loc.monthlyYieldShare.reduce((a, b) => a + b, 0) * loc.specificYield_kWh_per_kWp).toFixed(0),
    temp: +Number(loc.tempMeanC[i]).toFixed(1),
  })), [stats, loc]);

  /* --- Handlers ------------------------------------------------------------ */
  const onLoadFile = (e) => {
    const f = e.target.files?.[0]; if (!f) return;
    const r = new FileReader();
    r.onload = () => { const res = parseLoadCSV(String(r.result)); setCsvResult(res); if (res.load) setLoadCfg((s) => ({ ...s, path: "csv" })); };
    r.readAsText(f);
  };

  const onResourceFile = (e) => {
    const f = e.target.files?.[0]; if (!f) return;
    const r = new FileReader();
    r.onload = () => {
      const res = Papa.parse(String(r.result).trim(), { header: true, skipEmptyLines: true, dynamicTyping: true });
      const rows = res.data;
      if (!rows.length) { setResourceSource((s) => ({ ...s, note: "No rows found in the resource file." })); return; }
      const keys = Object.keys(rows[0]).map((k) => k.toLowerCase());
      const findKey = (re) => Object.keys(rows[0])[keys.findIndex((k) => re.test(k))];
      const gk = findKey(/ghi|irrad|g\(i\)|production|kwh|kw\b|p_pv|specific/);
      const tk = findKey(/temp|t2m|ambient|dry/);
      const next = {}; const notes = [];
      if (gk) {
        const v = rows.map((r0) => Number(r0[gk]) || 0);
        const arr = new Float32Array(H);
        for (let i = 0; i < H; i++) arr[i] = v[i % v.length];
        let s = 0; for (let i = 0; i < H; i++) s += arr[i];
        if (s > 5000) { const k = loc.specificYield_kWh_per_kWp / s; for (let i = 0; i < H; i++) arr[i] *= k; notes.push("Resource column scaled to the stated specific yield."); }
        next.pvUnit = arr;
      }
      if (tk) {
        const v = rows.map((r0) => Number(r0[tk]) || 0);
        const arr = new Float32Array(H);
        for (let i = 0; i < H; i++) arr[i] = v[i % v.length];
        next.temp = arr;
      }
      setUploadedResource(Object.keys(next).length ? next : null);
      setResourceSource({ pv: next.pvUnit ? "site" : "library", temp: next.temp ? "site" : "library", note: `${rows.length} rows read. ${gk ? `Resource column "${gk}". ` : "No resource column found. "}${tk ? `Temperature column "${tk}". ` : "No temperature column found. "}${notes.join(" ")}` });
    };
    r.readAsText(f);
  };

  const setCooling = (t) => {
    const c = CONSTANTS.COOLING[t];
    const climateAdder = Math.min(CONSTANTS.PUE_CLIMATE_ADDER_MAX,
      Math.max(0, (annualMeanT - CONSTANTS.PUE_CLIMATE_REF_TEMP_C) * CONSTANTS.PUE_CLIMATE_ADDER_PER_C));
    setAidc((s) => ({ ...s, coolingType: t, designPUE: +(c.designPUE + climateAdder).toFixed(3), freeCoolingBelowC: c.freeCoolingBelowC, designAmbientC: c.designAmbientC, pueTouched: false }));
  };

  const applyUseCase = (k) => {
    const d = USE_CASE_FAMILIES[k].defaults;
    setCtx((s) => ({ ...s, useCase: k, islanding: d.islanding, autonomyH: d.autonomyH }));
    if (!char.touched) setChar((s) => ({ ...s, critPct: d.critPct, shed1Pct: Math.round((100 - d.critPct) * 0.6), shed2Pct: 100 - d.critPct - Math.round((100 - d.critPct) * 0.6) }));
  };

  const aidcTrace = aidcDerived && aidcOut ? [
    { label: "IT draw", expr: `${fmt(aidcYearMW, 1)} MW IT × ${fmt(aidc.itUtilisationPct, 0)} % utilisation`, result: `${fmt(aidcDerived.itKW / 1000, 2)} MW` },
    { label: "Non-cooling overhead", expr: `IT × ${fmt(aidcDerived.otherPct, 1)} % (UPS ${aidc.upsPresent ? CONSTANTS.UPS_LOSS_PCT_OF_IT : 0} + dist ${CONSTANTS.DISTRIBUTION_LOSS_PCT_OF_IT} + misc ${CONSTANTS.MISC_LOAD_PCT_OF_IT})`, result: `${fmt(aidcDerived.otherKW / 1000, 2)} MW` },
    { label: "Cooling at design", expr: `IT × (PUE ${fmt(aidc.designPUE, 3)} − 1) − overhead, quoted at ${fmt(aidc.designAmbientC, 0)} °C`, result: `${fmt(aidcDerived.coolingDesignKW / 1000, 2)} MW` },
    { label: "Free cooling", expr: `hours at or below ${fmt(aidc.freeCoolingBelowC, 0)} °C dry bulb`, result: `${fmt(aidcDerived.freeHours, 0)} h/yr (${fmt(100 * aidcDerived.freeHours / H, 0)} %)` },
    { label: "Annualised PUE", expr: `facility energy ÷ IT energy over 8760 h at ${loc.label}`, result: fmt(aidcDerived.annualisedPUE, 3) },
    { label: "Peak, typical year", expr: `max of hourly IT + cooling(T) + overhead over 8760 h`, result: `${fmt(aidcOut.peakMW, 2)} MW` },
    { label: "Load at design ambient", expr: `IT + cooling at 100 % of design + overhead, at ${fmt(aidc.designAmbientC, 0)} °C`, result: `${fmt(aidcOut.designPeakMW, 2)} MW` },
    { label: "Firm capacity req.", expr: `max(typical peak, design load) ${fmt(aidcOut.sizingBasisMW, 2)} MW × ${fmt(aidcOut.red.firmFactor, 2)} (${aidcOut.red.label})`, result: `${fmt(aidcOut.firmMW, 2)} MW` },
    { label: "Largest load step", expr: `IT ${fmt(aidcDerived.itKW / 1000, 2)} MW × ${fmt(aidc.loadSwingPct, 0)} % swing over ${fmt(aidc.loadSwingSeconds, 0)} s`, result: `${fmt(aidcOut.stepKW / 1000, 2)} MW` },
    { label: "PV cap from land", expr: `${fmt(aidc.landPV_ha, 1)} ha × 10 000 m²/ha ÷ ${fmt(aidc.pvAreaPerKWp, 1)} m²/kWp`, result: `${fmt(aidcOut.maxKWp / 1000, 2)} MWp max` },
    { label: "BESS cap from area", expr: `${fmt(aidc.landBESS_m2, 0)} m² ÷ ${fmt(aidc.bessFootprint, 0)} m²/MW`, result: `${fmt(aidcOut.maxBessMW, 1)} MW max` },
    { label: "Engine cap from area", expr: `${fmt(aidc.landEngine_m2, 0)} m² ÷ ${fmt(aidc.engineFootprint, 0)} m²/MW`, result: `${fmt(aidcOut.maxEngineMW, 1)} MW max` },
  ] : [];

  const parasiticKW = char.parasiticMode === "pct" ? stats.meanKW * char.parasiticPct / 100 : char.parasiticKW;
  const axis = { stroke: T.chart.axis, fontSize: 10 };
  const tip = { backgroundColor: T.chart.tipBg, border: `1px solid ${T.chart.tipBorder}`, borderRadius: 4, fontSize: 11 };

  /* ========================================================================= */
  return (
    <ThemeCtx.Provider value={T}>
      <div className={`min-h-screen p-3 ${T.app}`}>
        <div className="mx-auto max-w-7xl space-y-3">

          {/* Header */}
          <header className={`flex flex-wrap items-end justify-between gap-3 border-b pb-3 ${T.rule}`}>
            <div>
              <h1 className={`text-lg font-semibold tracking-tight ${T.title}`}>Microgrid design tool</h1>
              <p className={`text-xs ${T.faint}`}>Pre-feasibility sizing, dispatch and LCOE. Not a substitute for a protection study, an EMT study or a contractor's price.</p>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <Seg value={themeKey} onChange={setThemeKey} options={[{ value: "dark", label: "Dark" }, { value: "light", label: "Light" }]} />
              <Seg value={density} onChange={setDensity} options={[{ value: "essential", label: "Essentials" }, { value: "full", label: "Every parameter" }]} />
              <Seg value={mode} onChange={setMode} options={[{ value: "standard", label: "Standard project" }, { value: "aidc", label: "AIDC design" }]} />
            </div>
          </header>

          {/* Build progress + input key */}
          <div className="flex flex-wrap items-center gap-2">
            {PHASES.map((p) => (
              <span key={p.n} className={`rounded border px-2 py-0.5 font-mono text-xs ${p.done ? T.chip : T.chipIdle}`}>
                {p.n}. {p.label}{p.done ? " ✓" : ""}
              </span>
            ))}
          </div>
          <div className={`flex flex-wrap items-center gap-4 rounded border px-2 py-1.5 ${T.tile}`}>
            <span className={`border-l-2 pl-2 text-xs ${T.critRule} ${T.critLabel}`}>Critical input — set it and check it</span>
            <span className={`text-xs ${T.advLabel}`}>Advanced parameter — defensible default, folded away</span>
            <span className={`ml-auto font-mono text-xs ${T.ghost}`}>{showAll ? "all parameters shown" : "advanced parameters folded"}</span>
          </div>

          {/* Headline */}
          <div className="grid grid-cols-2 gap-2 md:grid-cols-6">
            <div className={`col-span-2 rounded border px-2 py-1.5 ${T.panel}`}>
              <div className={`text-xs ${T.faint}`}>Load in use</div>
              <div className={`font-mono text-xs ${T.tone.cyan}`}>{loadSource.kind}</div>
              <div className={`text-xs ${T.muted}`}>{loadSource.text}</div>
            </div>
            <Stat label="Annual energy" value={fmt(stats.annualMWh, 0)} unit="MWh/yr" />
            <Stat label="Peak demand" value={fmt(stats.peakKW / 1000, 2)} unit="MW" tone="amber" />
            <Stat label="Minimum load" value={fmt(stats.minKW / 1000, 2)} unit="MW" />
            <Stat label="Load factor" value={fmt(stats.loadFactor * 100, 1)} unit="%" tone="cyan" />
          </div>

          <Notices items={notices} />

          {/* 1. PROJECT CONTEXT */}
          <Panel title="Project context" step="1" sub="drives defaults and which adequacy check binds">
            <div className="grid grid-cols-1 gap-3 md:grid-cols-4">
              <Field tier="critical" label="Use-case family" unit="—" hint={USE_CASE_FAMILIES[ctx.useCase].binding}>
                <Sel value={ctx.useCase} onChange={applyUseCase} options={Object.entries(USE_CASE_FAMILIES).map(([k, v]) => ({ value: k, label: v.label }))} />
              </Field>
              <Field tier="critical" label="Grid status" unit="—">
                <Sel value={ctx.gridStatus} onChange={(v) => setCtx((s) => ({ ...s, gridStatus: v }))}
                  options={[
                    { value: "none", label: "No connection (off-grid)" },
                    { value: "firm", label: "Firm connection, import cap" },
                    { value: "flexible", label: "Flexible / non-firm (curtailable)" },
                    { value: "phased", label: "Phased connection (stepped caps)" },
                  ]} />
              </Field>
              {ctx.gridStatus !== "none" && (
                <Field tier="critical" label="Import cap" unit="kW"><Num value={ctx.importCapKW} step={100} onChange={(v) => setCtx((s) => ({ ...s, importCapKW: v }))} /></Field>
              )}
              <Field tier="critical" label="Islanding requirement" unit="—">
                <Sel value={ctx.islanding} onChange={(v) => setCtx((s) => ({ ...s, islanding: v }))}
                  options={[{ value: "none", label: "None" }, { value: "planned", label: "Planned islanding" }, { value: "unplanned", label: "Unplanned islanding" }]} />
              </Field>
              <Field tier="critical" label="Required autonomy at critical load" unit="h">
                <Num value={ctx.autonomyH} onChange={(v) => setCtx((s) => ({ ...s, autonomyH: v }))} disabled={ctx.islanding === "none"} />
              </Field>
              <Field tier="critical" label="Location" unit="—">
                <Sel value={ctx.locationId} onChange={(v) => { setCtx((s) => ({ ...s, locationId: v })); setLocOverride({}); setUploadedResource(null); setResourceSource({ pv: "library", temp: "library", note: null }); }}
                  options={Object.entries(LOCATION_LIBRARY).map(([k, v]) => ({ value: k, label: v.label }))} />
              </Field>
              <Field tier="critical" label="Project life" unit="years"><Num value={ctx.lifeYears} onChange={(v) => setCtx((s) => ({ ...s, lifeYears: v }))} /></Field>
              <Field tier="critical" label="Discount rate (real)" unit="%/yr" hint="LCOE moves with this as much as with capex">
                <Num value={ctx.discountPct} step={0.1} onChange={(v) => setCtx((s) => ({ ...s, discountPct: v }))} />
              </Field>
            </div>

            <Advanced key={`ctx-${density}`} title="Advanced — connection detail and currency" count={ctx.gridStatus === "flexible" ? 4 : 2} defaultOpen={showAll}>
              <div className="grid grid-cols-1 gap-3 md:grid-cols-4">
                <Field label="Export cap" unit="kW" hint="0 = no export allowed"><Num value={ctx.exportCapKW} step={100} onChange={(v) => setCtx((s) => ({ ...s, exportCapKW: v }))} /></Field>
                <Field label="Currency" unit="—"><Txt value="EUR" readOnly /></Field>
                {ctx.gridStatus === "flexible" && (<>
                  <Field label="Reduced cap when curtailed" unit="kW"><Num value={ctx.flexReducedCapKW} step={100} onChange={(v) => setCtx((s) => ({ ...s, flexReducedCapKW: v }))} /></Field>
                  <Field label="Hours at reduced cap" unit="% of year"><Num value={ctx.flexPctHours} onChange={(v) => setCtx((s) => ({ ...s, flexPctHours: v }))} /></Field>
                </>)}
                {ctx.gridStatus === "phased" && (
                  <div className="md:col-span-4">
                    <div className={`mb-1 flex items-baseline justify-between`}><span className={`text-xs ${T.advLabel}`}>Connection steps</span><span className={`font-mono text-xs ${T.ghost}`}>year → kW</span></div>
                    <div className="space-y-1">
                      {ctx.phases.map((p, i) => (
                        <div key={i} className="flex gap-2">
                          <Num value={p.year} onChange={(v) => setCtx((s) => { const ph = [...s.phases]; ph[i] = { ...ph[i], year: v }; return { ...s, phases: ph }; })} />
                          <Num value={p.capKW} step={100} onChange={(v) => setCtx((s) => { const ph = [...s.phases]; ph[i] = { ...ph[i], capKW: v }; return { ...s, phases: ph }; })} />
                          <button className={`rounded border px-2 text-xs ${T.btn}`} onClick={() => setCtx((s) => ({ ...s, phases: s.phases.filter((_, j) => j !== i) }))}>−</button>
                        </div>
                      ))}
                      <button className={`rounded border px-2 py-1 text-xs ${T.btn}`}
                        onClick={() => setCtx((s) => ({ ...s, phases: [...s.phases, { year: (s.phases.at(-1)?.year || 0) + 1, capKW: 0 }] }))}>Add step</button>
                    </div>
                  </div>
                )}
              </div>
            </Advanced>
          </Panel>

          {/* 1B. LOCATION AND RESOURCE */}
          <Panel title="Location and resource" step="1B" sub="LCOE moves more with yield than with equipment price"
            right={
              <div className="flex items-center gap-2">
                <span className={`rounded px-2 py-0.5 font-mono text-xs ${resourceSource.pv === "site" ? T.chipOk : T.chipWarn}`}>
                  {resourceSource.pv === "site" ? "site data" : "library default"} ±{resourceSource.pv === "site" ? CONSTANTS.SITE_YIELD_UNCERTAINTY_PCT : CONSTANTS.LIBRARY_YIELD_UNCERTAINTY_PCT}%
                </span>
                <button onClick={() => resFileRef.current?.click()} className={`rounded border px-2 py-1 text-xs ${T.btn}`}>Upload PVGIS / TMY / 8760</button>
                <input ref={resFileRef} type="file" accept=".csv,.txt" className="hidden" onChange={onResourceFile} />
              </div>
            }>
            <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
              <Field tier="critical" label="Specific yield" unit="kWh/kWp/yr" flag={resourceSource.pv === "library" ? "library default" : null}>
                <Num value={loc.specificYield_kWh_per_kWp} step={10} onChange={(v) => setLocOverride((s) => ({ ...s, specificYield_kWh_per_kWp: v }))} />
              </Field>
              <Field tier="critical" label="Grid import tariff" unit="€/MWh"><Num value={loc.importTariff_EUR_per_MWh} onChange={(v) => setLocOverride((s) => ({ ...s, importTariff_EUR_per_MWh: v }))} /></Field>
              <Field tier="critical" label="Diesel price" unit="€/litre"><Num value={loc.diesel_EUR_per_litre} step={0.05} onChange={(v) => setLocOverride((s) => ({ ...s, diesel_EUR_per_litre: v }))} /></Field>
              <Field tier="critical" label="Gas price" unit="€/MWh th"><Num value={loc.gas_EUR_per_MWh_th} onChange={(v) => setLocOverride((s) => ({ ...s, gas_EUR_per_MWh_th: v }))} /></Field>
            </div>

            <Advanced key={`loc-${density}`} title="Advanced — site physics, tariff structure and monthly shapes" count={7} defaultOpen={showAll}>
              <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
                <Field label="Latitude" unit="°"><Num value={loc.lat} step={0.01} onChange={(v) => setLocOverride((s) => ({ ...s, lat: v }))} /></Field>
                <Field label="Mean wind speed @100 m" unit="m/s"><Num value={loc.windMean_m_s_100m} step={0.1} onChange={(v) => setLocOverride((s) => ({ ...s, windMean_m_s_100m: v }))} /></Field>
                <Field label="Weibull shape k" unit="—"><Num value={loc.weibullK} step={0.1} onChange={(v) => setLocOverride((s) => ({ ...s, weibullK: v }))} /></Field>
                <Field label="Diurnal swing" unit="°C"><Num value={loc.diurnalSwingC} step={0.5} onChange={(v) => setLocOverride((s) => ({ ...s, diurnalSwingC: v }))} /></Field>
                <Field label="Grid fees" unit="€/MWh"><Num value={loc.gridFee_EUR_per_MWh} onChange={(v) => setLocOverride((s) => ({ ...s, gridFee_EUR_per_MWh: v }))} /></Field>
                <Field label="Capacity charge" unit="€/kW/yr"><Num value={loc.capacityCharge_EUR_per_kW_yr} onChange={(v) => setLocOverride((s) => ({ ...s, capacityCharge_EUR_per_kW_yr: v }))} /></Field>
                <Field label="Grid emission factor" unit="gCO₂/kWh"><Num value={loc.gridCO2_g_per_kWh} onChange={(v) => setLocOverride((s) => ({ ...s, gridCO2_g_per_kWh: v }))} /></Field>
                <Field label="Annual mean dry bulb" unit="°C"><Txt value={fmt(annualMeanT, 1)} readOnly /></Field>
              </div>

              <div className="mt-3 grid grid-cols-1 gap-3 lg:grid-cols-2">
                <div>
                  <div className={`mb-1 text-xs ${T.faint}`}>Monthly PV yield share — relative, normalised in code</div>
                  <div className="grid grid-cols-6 gap-1">
                    {loc.monthlyYieldShare.map((v, i) => (
                      <div key={i}>
                        <div className={`text-center font-mono text-xs ${T.ghost}`}>{MONTHS[i]}</div>
                        <input type="number" step={0.1} value={v}
                          className={`w-full rounded border px-1 py-0.5 text-center font-mono text-xs ${T.micro}`}
                          onChange={(e) => { const arr = [...loc.monthlyYieldShare]; arr[i] = Number(e.target.value); setLocOverride((s) => ({ ...s, monthlyYieldShare: arr })); }} />
                      </div>
                    ))}
                  </div>
                </div>
                <div>
                  <div className={`mb-1 text-xs ${T.faint}`}>Monthly mean dry bulb (°C) — PV derate, free cooling, thermal plant derating</div>
                  <div className="grid grid-cols-6 gap-1">
                    {loc.tempMeanC.map((v, i) => (
                      <div key={i}>
                        <div className={`text-center font-mono text-xs ${T.ghost}`}>{MONTHS[i]}</div>
                        <input type="number" step={0.5} value={v}
                          className={`w-full rounded border px-1 py-0.5 text-center font-mono text-xs ${T.micro}`}
                          onChange={(e) => { const arr = [...loc.tempMeanC]; arr[i] = Number(e.target.value); setLocOverride((s) => ({ ...s, tempMeanC: arr })); }} />
                      </div>
                    ))}
                  </div>
                </div>
              </div>
            </Advanced>

            {resourceSource.note && <div className={`mt-2 rounded border px-2 py-1 text-xs ${T.tile} ${T.muted}`}>{resourceSource.note}</div>}

            <div className="mt-3 grid grid-cols-1 gap-3 lg:grid-cols-2">
              <div>
                <div className={`mb-1 text-xs ${T.faint}`}>Monthly PV yield (kWh/kWp) and mean dry bulb (°C)</div>
                <div className="h-44">
                  <ResponsiveContainer width="100%" height="100%">
                    <ComposedChart data={monthlyChart} margin={{ top: 5, right: 5, left: -20, bottom: 0 }}>
                      <CartesianGrid stroke={T.chart.grid} vertical={false} />
                      <XAxis dataKey="m" tick={axis} />
                      <YAxis yAxisId="l" tick={axis} />
                      <YAxis yAxisId="r" orientation="right" tick={axis} />
                      <Tooltip contentStyle={tip} />
                      <Bar yAxisId="l" dataKey="yield" name="kWh/kWp" fill={T.chart.bar2} />
                      <Line yAxisId="r" type="monotone" dataKey="temp" name="°C" stroke={T.chart.load} dot={false} />
                    </ComposedChart>
                  </ResponsiveContainer>
                </div>
              </div>
              <div className="grid grid-cols-2 gap-2 content-start">
                <Stat label="Equivalent full-load hours, PV" value={fmt(loc.specificYield_kWh_per_kWp, 0)} unit="h/yr" tone="amber" />
                <Stat label="Hours ≥ 30 °C" value={fmt(Array.from(temp).filter((t) => t >= 30).length, 0)} unit="h/yr" tone="rose" />
                <Stat label="Hours ≤ 18 °C" value={fmt(Array.from(temp).filter((t) => t <= 18).length, 0)} unit="h/yr" tone="cyan" />
                <Stat label="Yield uncertainty band" value={`±${resourceSource.pv === "site" ? CONSTANTS.SITE_YIELD_UNCERTAINTY_PCT : CONSTANTS.LIBRARY_YIELD_UNCERTAINTY_PCT}`} unit="% P50" />
              </div>
            </div>
            <p className={`mt-2 text-xs ${T.faint}`}>
              LCOE sensitivity to yield, capex and discount rate is charted in Phase 4. Location comparison mode is built in Phase 5.
            </p>
          </Panel>

          {/* 1A. AIDC */}
          {mode === "aidc" && (
            <Panel title="AI data centre design inputs" step="1A" sub="sized backwards from a capacity target, not from a measured load">
              <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
                <Field tier="critical" label="Target IT capacity, design" unit="MW IT"><Num value={aidc.targetMWIT} step={0.5} onChange={(v) => setAidc((s) => ({ ...s, targetMWIT: v }))} /></Field>
                <Field tier="critical" label="Cooling type" unit="—">
                  <Sel value={aidc.coolingType} onChange={setCooling} options={Object.entries(CONSTANTS.COOLING).map(([k, v]) => ({ value: k, label: v.label }))} />
                </Field>
                <Field tier="critical" label="Design PUE" unit="—" flag={aidc.pueTouched ? null : "default for this cooling type and climate"}>
                  <Num value={aidc.designPUE} step={0.01} onChange={(v) => setAidc((s) => ({ ...s, designPUE: v, pueTouched: true }))} />
                </Field>
                <Field tier="critical" label="Redundancy level" unit="—">
                  <Sel value={aidc.redundancy} onChange={(v) => setAidc((s) => ({ ...s, redundancy: v }))} options={Object.entries(CONSTANTS.REDUNDANCY).map(([k, v]) => ({ value: k, label: v.label }))} />
                </Field>
                <Field tier="critical" label="Grid supply strategy" unit="—">
                  <Sel value={aidc.gridStrategy} onChange={(v) => setAidc((s) => ({ ...s, gridStrategy: v }))}
                    options={[
                      { value: "grid100", label: "100 % from grid (assets for resilience only)" },
                      { value: "capped", label: "Capped import + on-site balance" },
                      { value: "phased", label: "Phased import caps" },
                      { value: "offgrid", label: "Fully off-grid" },
                    ]} />
                </Field>
                <Field tier="critical" label="Land available for PV" unit="ha"><Num value={aidc.landPV_ha} step={0.5} onChange={(v) => setAidc((s) => ({ ...s, landPV_ha: v }))} /></Field>
                <Field tier="critical" label="Permitted engine running hours" unit="h/yr"><Num value={aidc.engineHoursLimit} step={50} onChange={(v) => setAidc((s) => ({ ...s, engineHoursLimit: v }))} /></Field>
                <Field tier="critical" label="Collective compute swing" unit="% of IT" hint="largest load step for the dynamic check">
                  <Num value={aidc.loadSwingPct} onChange={(v) => setAidc((s) => ({ ...s, loadSwingPct: v }))} />
                </Field>
              </div>

              {/* Ramp is critical */}
              <div className="mt-3 grid grid-cols-1 gap-3 lg:grid-cols-3">
                <div className={`border-l-2 pl-2 ${T.critRule}`}>
                  <div className="mb-1 flex items-baseline justify-between">
                    <span className={`text-xs font-medium ${T.critLabel}`}>Phased fit-out</span>
                    <span className={`font-mono text-xs ${T.ghost}`}>year → MW IT</span>
                  </div>
                  <div className="space-y-1">
                    {aidc.ramp.map((r, i) => (
                      <div key={i} className="flex items-center gap-2">
                        <Num value={r.year} onChange={(v) => setAidc((s) => { const a = [...s.ramp]; a[i] = { ...a[i], year: v }; return { ...s, ramp: a }; })} />
                        <Num value={r.mwIT} step={0.5} onChange={(v) => setAidc((s) => { const a = [...s.ramp]; a[i] = { ...a[i], mwIT: v }; return { ...s, ramp: a }; })} />
                        <button onClick={() => setAidc((s) => ({ ...s, ramp: s.ramp.filter((_, j) => j !== i) }))} className={`rounded border px-2 text-xs ${T.btn}`}>−</button>
                      </div>
                    ))}
                    <div className="flex gap-2">
                      <button onClick={() => setAidc((s) => ({ ...s, ramp: [...s.ramp, { year: (s.ramp.at(-1)?.year || 0) + 1, mwIT: s.targetMWIT }] }))}
                        className={`rounded border px-2 py-1 text-xs ${T.btn}`}>Add year</button>
                      <div className="flex-1">
                        <Sel value={String(aidc.analysisYear)} onChange={(v) => setAidc((s) => ({ ...s, analysisYear: Number(v) }))}
                          options={aidc.ramp.map((r) => ({ value: String(r.year), label: `Analyse year ${r.year} — ${r.mwIT} MW IT` }))} />
                      </div>
                    </div>
                  </div>
                </div>
                <div className="lg:col-span-2"><Trace lines={aidcTrace} /></div>
              </div>

              <Advanced key={`aidc-${density}`} title="Advanced — thermal design point, UPS, footprints and site limits" count={11} defaultOpen={showAll}>
                <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
                  <Field label="Design ambient for that PUE" unit="°C"><Num value={aidc.designAmbientC} onChange={(v) => setAidc((s) => ({ ...s, designAmbientC: v }))} /></Field>
                  <Field label="Free cooling below" unit="°C dry bulb"><Num value={aidc.freeCoolingBelowC} onChange={(v) => setAidc((s) => ({ ...s, freeCoolingBelowC: v }))} /></Field>
                  <Field label="IT utilisation" unit="% of installed"><Num value={aidc.itUtilisationPct} onChange={(v) => setAidc((s) => ({ ...s, itUtilisationPct: v }))} /></Field>
                  <Field label="Swing timescale" unit="s"><Num value={aidc.loadSwingSeconds} onChange={(v) => setAidc((s) => ({ ...s, loadSwingSeconds: v }))} /></Field>
                  <Field label="UPS / ride-through" unit="—">
                    <Sel value={aidc.upsPresent ? "yes" : "no"} onChange={(v) => setAidc((s) => ({ ...s, upsPresent: v === "yes" }))} options={[{ value: "yes", label: "Present" }, { value: "no", label: "None" }]} />
                  </Field>
                  <Field label="UPS autonomy" unit="min"><Num value={aidc.upsAutonomyMin} onChange={(v) => setAidc((s) => ({ ...s, upsAutonomyMin: v }))} disabled={!aidc.upsPresent} /></Field>
                  <Field label="Chiller anti-recycle timer" unit="min"><Num value={aidc.antiRecycleMin} onChange={(v) => setAidc((s) => ({ ...s, antiRecycleMin: v }))} /></Field>
                  <Field label="Distribution topology" unit="text" hint="read by the single-point-of-failure check">
                    <Txt value={aidc.topology} onChange={(v) => setAidc((s) => ({ ...s, topology: v }))} />
                  </Field>
                  <Field label="Area per kWp" unit="m²/kWp"><Num value={aidc.pvAreaPerKWp} step={0.5} onChange={(v) => setAidc((s) => ({ ...s, pvAreaPerKWp: v }))} /></Field>
                  <Field label="Footprint for BESS" unit="m²"><Num value={aidc.landBESS_m2} step={100} onChange={(v) => setAidc((s) => ({ ...s, landBESS_m2: v }))} /></Field>
                  <Field label="Footprint for engines" unit="m²"><Num value={aidc.landEngine_m2} step={100} onChange={(v) => setAidc((s) => ({ ...s, landEngine_m2: v }))} /></Field>
                  <Field label="Water for evaporative cooling" unit="—">
                    <Sel value={aidc.waterAvailable ? "yes" : "no"} onChange={(v) => setAidc((s) => ({ ...s, waterAvailable: v === "yes" }))} options={[{ value: "no", label: "No" }, { value: "yes", label: "Yes" }]} />
                  </Field>
                  <Field label="Noise / emissions limit note" unit="text">
                    <Txt value={aidc.noiseLimitNote} placeholder="e.g. 45 dB(A) at boundary, night dispatch blocked" onChange={(v) => setAidc((s) => ({ ...s, noiseLimitNote: v }))} />
                  </Field>
                </div>
              </Advanced>

              <div className="mt-3 grid grid-cols-2 gap-2 md:grid-cols-6">
                <Stat label="IT load" value={fmt(aidcDerived.itKW / 1000, 2)} unit="MW" />
                <Stat label="Cooling at design" value={fmt(aidcDerived.coolingDesignKW / 1000, 2)} unit="MW" tone="cyan" />
                <Stat label="Other overhead" value={fmt(aidcDerived.otherKW / 1000, 2)} unit="MW" />
                <Stat label={`Annualised PUE (design ${fmt(aidc.designPUE, 2)})`} value={fmt(aidcDerived.annualisedPUE, 3)} unit="—" tone="emerald" />
                <Stat label="Load at design ambient" value={fmt(aidcOut.designPeakMW, 2)} unit="MW" tone="amber" />
                <Stat label="Largest load step" value={fmt(aidcOut.stepKW / 1000, 2)} unit="MW" tone="rose" />
              </div>
              <div className="mt-2 grid grid-cols-2 gap-2 md:grid-cols-6">
                <Stat label="Firm capacity requirement" value={fmt(aidcOut.firmMW, 2)} unit="MW" tone="amber" />
                <Stat label="Peak, typical year" value={fmt(aidcOut.peakMW, 2)} unit="MW" />
                <Stat label="Free-cooling hours" value={fmt(aidcDerived.freeHours, 0)} unit="h/yr" tone="cyan" />
                <Stat label="PV cap from land" value={fmt(aidcOut.maxKWp / 1000, 2)} unit="MWp" tone="cyan" />
                <Stat label="BESS cap from area" value={fmt(aidcOut.maxBessMW, 1)} unit="MW" tone="violet" />
                <Stat label="Engine cap from area" value={fmt(aidcOut.maxEngineMW, 1)} unit="MW" />
              </div>
              <p className={`mt-2 text-xs ${T.faint}`}>
                IT and cooling are both non-sheddable. Criticality is pre-filled at {fmt(aidcOut.critPct, 0)} % of mean load and can be overridden below.
                €/MW IT capex, LCOE per MWh delivered to IT, time-to-power and the 2N single-point-of-failure check come in Phases 4 and 5.
              </p>
            </Panel>
          )}

          {/* 2. LOAD INPUT */}
          {mode === "standard" && (
            <Panel title="Load input" step="2"
              right={<Seg value={loadCfg.path} onChange={(v) => setLoadCfg((s) => ({ ...s, path: v }))}
                options={[{ value: "csv", label: "Upload CSV" }, { value: "parametric", label: "Parametric" }]} />}>
              {loadCfg.path === "csv" ? (
                <div className="space-y-2">
                  <div className="flex flex-wrap items-center gap-2">
                    <button onClick={() => fileRef.current?.click()} className={`rounded border px-3 py-1 text-xs ${T.chip}`}>Choose a CSV file</button>
                    <input ref={fileRef} type="file" accept=".csv,.txt" className="hidden" onChange={onLoadFile} />
                    <span className={`text-xs ${T.faint}`}>Accepts timestamp + kW, or kWh per interval. 15-minute and 30-minute data are averaged to hourly.</span>
                  </div>
                  {csvResult?.error && <div className={`rounded border px-2 py-1 text-xs ${T.notice.fail}`}>{csvResult.error}</div>}
                  {csvResult?.notes && (
                    <div className={`rounded border p-2 ${T.tile}`}>
                      <div className={`mb-1 text-xs uppercase tracking-wide ${T.faint}`}>What was parsed and what was fixed</div>
                      <ul className="space-y-0.5">
                        {csvResult.notes.map((n, i) => <li key={i} className={`font-mono text-xs ${T.muted}`}>· {n}</li>)}
                      </ul>
                    </div>
                  )}
                </div>
              ) : (
                <>
                  <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
                    <Field tier="critical" label="Annual energy" unit="MWh/yr"><Num value={loadCfg.annualEnergyMWh} step={100} onChange={(v) => setLoadCfg((s) => ({ ...s, annualEnergyMWh: v }))} /></Field>
                    <Field tier="critical" label="Peak demand" unit="kW"><Num value={loadCfg.peakKW} step={50} onChange={(v) => setLoadCfg((s) => ({ ...s, peakKW: v }))} /></Field>
                    <Field tier="critical" label="Base / minimum load" unit="kW"><Num value={loadCfg.baseKW} step={50} onChange={(v) => setLoadCfg((s) => ({ ...s, baseKW: v }))} /></Field>
                    <Field tier="critical" label="Profile shape" unit="—">
                      <Sel value={loadCfg.shapeKey} onChange={(v) => setLoadCfg((s) => ({ ...s, shapeKey: v }))} options={Object.entries(LOAD_SHAPES).map(([k, v]) => ({ value: k, label: v.label }))} />
                    </Field>
                  </div>
                  <Advanced key={`load-${density}`} title="Advanced — seasonality, weekend factor and custom hourly shape" count={4} defaultOpen={showAll}>
                    <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
                      <Field label="Seasonal weighting" unit="± %"><Num value={loadCfg.seasonality} onChange={(v) => setLoadCfg((s) => ({ ...s, seasonality: v }))} /></Field>
                      <Field label="Season peaking" unit="—">
                        <Sel value={loadCfg.seasonalPeak} onChange={(v) => setLoadCfg((s) => ({ ...s, seasonalPeak: v }))}
                          options={[{ value: "winter", label: "Winter peaking" }, { value: "summer", label: "Summer peaking" }, { value: "none", label: "No seasonality" }]} />
                      </Field>
                      <Field label="Weekend factor" unit="× weekday"><Num value={loadCfg.weekendFactor} step={0.05} onChange={(v) => setLoadCfg((s) => ({ ...s, weekendFactor: v }))} /></Field>
                      <Field label="Shape exponent γ solved" unit="—" hint="load = base + (peak − base) · shape^γ"><Txt value={fmt(synth?.gamma, 3)} readOnly /></Field>
                      {loadCfg.shapeKey === "custom" && (
                        <div className="md:col-span-4">
                          {[["customWeekday", "Weekday"], ["customWeekend", "Weekend"]].map(([key, lbl]) => (
                            <div key={key} className="mb-2">
                              <div className={`mb-0.5 font-mono text-xs ${T.ghost}`}>{lbl} — hourly factors 0–1</div>
                              <div className="grid grid-cols-12 gap-0.5">
                                {loadCfg[key].map((v, i) => (
                                  <input key={i} type="number" step={0.05} min={0} max={1} value={v}
                                    className={`w-full rounded border px-0.5 py-0.5 text-center font-mono text-xs ${T.micro}`}
                                    onChange={(e) => setLoadCfg((s) => { const a = [...s[key]]; a[i] = Number(e.target.value); return { ...s, [key]: a }; })} />
                                ))}
                              </div>
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  </Advanced>
                </>
              )}
            </Panel>
          )}

          {/* LOAD CHARACTERISATION */}
          <Panel title="Load characterisation" step={mode === "aidc" ? "1A·2" : "2B"} sub="separate inputs — not derivable from the profile">
            <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
              <Field tier="critical" label="Critical load (served in island)" unit="% of load">
                <Num value={char.critPct} onChange={(v) => setChar((s) => ({ ...s, critPct: v, touched: true }))} />
              </Field>
              <Field tier="critical" label="Largest single load step" unit="kW" hint={mode === "aidc" ? "pre-filled from the compute swing" : "drives the dynamic adequacy check"}>
                <Num value={mode === "aidc" && !char.touched ? Math.round(aidcOut.stepKW) : char.stepKW} step={10} onChange={(v) => setChar((s) => ({ ...s, stepKW: v, touched: true }))} />
              </Field>
              <Field tier="critical" label="Largest motor start" unit="kW"><Num value={char.motorKW} step={10} onChange={(v) => setChar((s) => ({ ...s, motorKW: v, touched: true }))} /></Field>
              <Field tier="critical" label="Critical load at peak" unit="kW"><Txt value={fmt(stats.peakKW * char.critPct / 100, 0)} readOnly /></Field>
            </div>

            <Advanced key={`char-${density}`} title="Advanced — shedding tiers, starting method and parasitics" count={4} defaultOpen={showAll}>
              <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
                <Field label="Sheddable tier 1" unit="% of load"><Num value={char.shed1Pct} onChange={(v) => setChar((s) => ({ ...s, shed1Pct: v, touched: true }))} /></Field>
                <Field label="Sheddable tier 2" unit="% of load"><Num value={char.shed2Pct} onChange={(v) => setChar((s) => ({ ...s, shed2Pct: v, touched: true }))} /></Field>
                <Field label="Starting method" unit="—">
                  <Sel value={char.motorMethod} onChange={(v) => setChar((s) => ({ ...s, motorMethod: v }))}
                    options={[{ value: "DOL", label: "Direct on line" }, { value: "SOFT", label: "Soft starter" }, { value: "VSD", label: "VSD" }]} />
                </Field>
                <Field label="Parasitic / auxiliary load" unit={char.parasiticMode === "pct" ? "% of mean" : "kW"} hint="included in the island load, never omitted">
                  <div className="flex gap-1">
                    <Sel value={char.parasiticMode} onChange={(v) => setChar((s) => ({ ...s, parasiticMode: v }))} options={[{ value: "pct", label: "%" }, { value: "kw", label: "kW" }]} />
                    {char.parasiticMode === "pct"
                      ? <Num value={char.parasiticPct} onChange={(v) => setChar((s) => ({ ...s, parasiticPct: v }))} />
                      : <Num value={char.parasiticKW} step={10} onChange={(v) => setChar((s) => ({ ...s, parasiticKW: v }))} />}
                  </div>
                </Field>
              </div>
            </Advanced>

            <div className="mt-3 grid grid-cols-2 gap-2 md:grid-cols-4">
              <Stat label="Parasitic load" value={fmt(parasiticKW, 0)} unit="kW" />
              <Stat label="Island load at peak (critical + parasitic)" value={fmt((stats.peakKW * char.critPct / 100 + parasiticKW) / 1000, 2)} unit="MW" tone="amber" />
              <Stat label={`Energy for ${fmt(ctx.autonomyH, 0)} h at critical load`} value={fmt(stats.peakKW * char.critPct / 100 * ctx.autonomyH / 1000, 2)} unit="MWh" tone="violet" />
              <Stat label="Autonomy required" value={fmt(ctx.autonomyH, 0)} unit="h" />
            </div>
          </Panel>

          {/* LOAD PROFILE */}
          <Panel title="Load profile" step="1C"
            right={
              <div className="flex flex-wrap items-center gap-2">
                <Seg value={view.span} onChange={(v) => setView((s) => ({ ...s, span: v }))}
                  options={[{ value: "day", label: "Day" }, { value: "week", label: "Week" }, { value: "month", label: "Month" }, { value: "year", label: "Year" }]} />
                {view.span !== "year" && (
                  <input type="range" min={0} max={364} value={view.startDay} className="w-40"
                    onChange={(e) => setView((s) => ({ ...s, startDay: Number(e.target.value) }))} />
                )}
                <span className={`font-mono text-xs ${T.faint}`}>{view.span === "year" ? "daily mean" : `from ${dayLabel(view.startDay)}`}</span>
              </div>
            }>
            <div className="h-64">
              <ResponsiveContainer width="100%" height="100%">
                <ComposedChart data={series} margin={{ top: 5, right: 5, left: -10, bottom: 0 }}>
                  <CartesianGrid stroke={T.chart.grid} vertical={false} />
                  <XAxis dataKey="t" tick={axis} minTickGap={40} />
                  <YAxis yAxisId="l" tick={axis} label={{ value: "kW", angle: -90, position: "insideLeft", fill: T.chart.axis, fontSize: 10 }} />
                  <YAxis yAxisId="r" orientation="right" tick={axis} />
                  <Tooltip contentStyle={tip} />
                  <Legend wrapperStyle={{ fontSize: 11 }} />
                  <Area yAxisId="l" type="monotone" dataKey="load" name="Load (kW)" stroke={T.chart.load} fill={T.chart.loadFill} fillOpacity={0.35} />
                  <Line yAxisId="r" type="monotone" dataKey="temp" name="Dry bulb (°C)" stroke={T.chart.temp} dot={false} strokeWidth={1} />
                  <Line yAxisId="r" type="monotone" dataKey="pv" name="PV (kW/kWp)" stroke={T.chart.pv} dot={false} strokeWidth={1} />
                </ComposedChart>
              </ResponsiveContainer>
            </div>

            <div className="mt-3 grid grid-cols-1 gap-3 lg:grid-cols-2">
              <div>
                <div className={`mb-1 text-xs ${T.faint}`}>Load duration curve — kW against % of hours exceeded</div>
                <div className="h-48">
                  <ResponsiveContainer width="100%" height="100%">
                    <LineChart data={ldc} margin={{ top: 5, right: 5, left: -10, bottom: 0 }}>
                      <CartesianGrid stroke={T.chart.grid} />
                      <XAxis dataKey="pct" tick={axis} unit="%" />
                      <YAxis tick={axis} />
                      <Tooltip contentStyle={tip} />
                      <ReferenceLine y={stats.meanKW} stroke={T.chart.ref} strokeDasharray="3 3" label={{ value: "mean", fill: T.chart.ref, fontSize: 10 }} />
                      {ctx.gridStatus !== "none" && (
                        <ReferenceLine y={ctx.importCapKW} stroke={T.chart.refWarn} strokeDasharray="4 2" label={{ value: "import cap", fill: T.chart.refWarn, fontSize: 10 }} />
                      )}
                      <Line type="monotone" dataKey="kW" stroke={T.chart.load} dot={false} strokeWidth={1.5} />
                    </LineChart>
                  </ResponsiveContainer>
                </div>
              </div>
              <div>
                <div className={`mb-1 text-xs ${T.faint}`}>Monthly energy — load (MWh) against PV yield (kWh/kWp)</div>
                <div className="h-48">
                  <ResponsiveContainer width="100%" height="100%">
                    <BarChart data={monthlyChart} margin={{ top: 5, right: 5, left: -10, bottom: 0 }}>
                      <CartesianGrid stroke={T.chart.grid} vertical={false} />
                      <XAxis dataKey="m" tick={axis} />
                      <YAxis yAxisId="l" tick={axis} />
                      <YAxis yAxisId="r" orientation="right" tick={axis} />
                      <Tooltip contentStyle={tip} />
                      <Legend wrapperStyle={{ fontSize: 11 }} />
                      <Bar yAxisId="l" dataKey="load" name="Load (MWh)" fill={T.chart.bar1} />
                      <Bar yAxisId="r" dataKey="yield" name="PV (kWh/kWp)" fill={T.chart.bar2} />
                    </BarChart>
                  </ResponsiveContainer>
                </div>
              </div>
            </div>

            <div className="mt-3 grid grid-cols-2 gap-2 md:grid-cols-6">
              <Stat label="Mean load" value={fmt(stats.meanKW / 1000, 2)} unit="MW" />
              <Stat label="Peak hour" value={`${dayLabel(cal.doy[stats.peakHour])} ${String(cal.hourOfDay[stats.peakHour]).padStart(2, "0")}h`} unit="" tone="amber" />
              <Stat label="Peak-to-base ratio" value={fmt(stats.peakKW / (stats.minKW || 1), 2)} unit="×" />
              <Stat label="Hours above 90 % peak" value={fmt(Array.from(load).filter((v) => v > 0.9 * stats.peakKW).length, 0)} unit="h/yr" />
              <Stat label="PV yield in use" value={fmt(loc.specificYield_kWh_per_kWp, 0)} unit="kWh/kWp" tone={resourceSource.pv === "site" ? "emerald" : "amber"} />
              <Stat label="Resource source" value={resourceSource.pv === "site" ? "site" : "library"} unit="" tone={resourceSource.pv === "site" ? "emerald" : "amber"} />
            </div>
          </Panel>

          <footer className={`border-t pt-2 text-xs ${T.rule} ${T.faint}`}>
            Phase 1 of 6 complete. Next — Phase 2: PV, wind, BESS, engine and turbine inputs, generation profiles, the priority-based dispatch engine, and the hourly table with reason codes.
          </footer>
        </div>
      </div>
    </ThemeCtx.Provider>
  );
}
