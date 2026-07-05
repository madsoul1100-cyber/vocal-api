/**
 * Approximate WGS84 centroids for Telangana districts (LGD `territories.code`).
 * Used when DB `centroid_lat` / `centroid_lng` are unset — e.g. pin-only intake.
 * HQ / district-centre coordinates; accurate enough for nearest-district routing.
 */
export const TELANGANA_DISTRICT_CENTROIDS_BY_CODE: Record<string, { lat: number; lng: number }> =
  {
    '522': { lat: 19.6643, lng: 78.532 }, // Adilabad
    '523': { lat: 17.5519, lng: 80.6188 }, // Bhadradri Kothagudem
    '524': { lat: 18.0104, lng: 79.5586 }, // Hanamkonda
    '525': { lat: 17.385, lng: 78.4867 }, // Hyderabad
    '526': { lat: 18.7947, lng: 78.9294 }, // Jagtial
    '527': { lat: 17.7333, lng: 79.15 }, // Jangaon
    '528': { lat: 18.6167, lng: 79.5167 }, // Jayashankar Bhupalpally
    '529': { lat: 16.235, lng: 77.795 }, // Jogulamba Gadwal
    '530': { lat: 18.32, lng: 78.34 }, // Kamareddy
    '531': { lat: 18.4386, lng: 79.1288 }, // Karimnagar
    '532': { lat: 17.2473, lng: 80.1514 }, // Khammam
    '533': { lat: 19.358, lng: 78.528 }, // Komaram Bheem Asifabad
    '534': { lat: 17.5983, lng: 80.005 }, // Mahabubabad
    '535': { lat: 16.7375, lng: 77.9856 }, // Mahabubnagar
    '536': { lat: 18.8722, lng: 79.4283 }, // Mancherial
    '537': { lat: 18.045, lng: 78.2631 }, // Medak
    '538': { lat: 17.5046, lng: 78.391 }, // Medchal-Malkajgiri
    '539': { lat: 18.1917, lng: 79.9333 }, // Mulugu
    '540': { lat: 16.4667, lng: 78.3167 }, // Nagarkurnool
    '541': { lat: 17.0575, lng: 79.2678 }, // Nalgonda
    '542': { lat: 16.75, lng: 77.5 }, // Narayanpet
    '543': { lat: 19.0968, lng: 78.3446 }, // Nirmal
    '544': { lat: 18.6725, lng: 78.0941 }, // Nizamabad
    '545': { lat: 18.6167, lng: 79.3833 }, // Peddapalli
    '546': { lat: 18.3889, lng: 78.8106 }, // Rajanna Sircilla
    '547': { lat: 17.385, lng: 78.4867 }, // Ranga Reddy
    '548': { lat: 17.6245, lng: 78.0867 }, // Sangareddy
    '549': { lat: 18.1019, lng: 78.852 }, // Siddipet
    '550': { lat: 17.15, lng: 79.6167 }, // Suryapet
    '551': { lat: 17.3381, lng: 77.9044 }, // Vikarabad
    '552': { lat: 16.3672, lng: 78.0689 }, // Wanaparthy
    '553': { lat: 17.9689, lng: 79.5941 }, // Warangal
    '554': { lat: 17.515, lng: 78.8856 }, // Yadadri Bhuvanagiri
  }
