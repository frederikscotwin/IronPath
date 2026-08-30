import os, struct, math, random
from datetime import datetime, timedelta, timezone

random.seed(7)
OUT = 'tests/samples'
os.makedirs(OUT, exist_ok=True)

# ---- TCX -------------------------------------------------------------------
def tcx(sport_attr, start, dur_s, dist_m, avg_hr, max_hr, cal):
    # a few trackpoints for elevation/hr coverage
    tps = []
    n = 6
    for i in range(n):
        t = start + timedelta(seconds=dur_s * i / (n - 1))
        ele = 20 + 8 * math.sin(i)
        hr = int(avg_hr + (max_hr - avg_hr) * (0.3 + 0.4 * math.sin(i)))
        tps.append(f"""        <Trackpoint><Time>{t.strftime('%Y-%m-%dT%H:%M:%SZ')}</Time>
          <AltitudeMeters>{ele:.1f}</AltitudeMeters>
          <HeartRateBpm><Value>{hr}</Value></HeartRateBpm></Trackpoint>""")
    return f"""<?xml version="1.0" encoding="UTF-8"?>
<TrainingCenterDatabase xmlns="http://www.garmin.com/xmlschemas/TrainingCenterDatabase/v2">
 <Activities><Activity Sport="{sport_attr}">
  <Id>{start.strftime('%Y-%m-%dT%H:%M:%SZ')}</Id>
  <Lap StartTime="{start.strftime('%Y-%m-%dT%H:%M:%SZ')}">
   <TotalTimeSeconds>{dur_s}</TotalTimeSeconds>
   <DistanceMeters>{dist_m}</DistanceMeters>
   <Calories>{cal}</Calories>
   <AverageHeartRateBpm><Value>{avg_hr}</Value></AverageHeartRateBpm>
   <MaximumHeartRateBpm><Value>{max_hr}</Value></MaximumHeartRateBpm>
   <Track>
{chr(10).join(tps)}
   </Track>
  </Lap>
 </Activity></Activities>
</TrainingCenterDatabase>"""

# Build ~12 weeks of a base block ending near "today" (fixed for reproducibility).
today = datetime(2026, 8, 27, tzinfo=timezone.utc)
start_day = today - timedelta(weeks=12)

# weekly pattern: (sport_attr, weekday, base_minutes, avg_hr, max_hr, speed_mps)
pattern = [
    ("Other",  0, 45, 128, 150, 0.85),   # swim (Garmin pool = Other)
    ("Biking", 1, 75, 132, 158, 7.8),
    ("Running",2, 40, 140, 165, 3.1),
    ("Other",  3, 40, 140, 168, 0.95),   # swim intervals
    ("Biking", 4, 60, 145, 172, 8.4),
    ("Biking", 5, 150,128, 150, 7.2),    # long ride
    ("Running",6, 75, 138, 160, 3.0),    # long run
]
count = 0
for w in range(12):
    mult = 0.7 if (w % 4 == 3) else (0.9 + (w % 4) * 0.05)
    for (sp, dow, mins, ahr, mhr, spd) in pattern:
        d = start_day + timedelta(weeks=w, days=dow, hours=8)
        dur = int(mins * 60 * mult)
        dist = int(dur * spd)
        cal = int(dur / 60 * 9)
        fn = f"{OUT}/{d.strftime('%Y%m%d')}_{sp.lower()}.tcx"
        with open(fn, 'w') as f:
            f.write(tcx(sp, d, dur, dist, ahr, mhr, cal))
        count += 1
print(f"wrote {count} TCX files")

# ---- one GPX (a run) -------------------------------------------------------
def gpx_run(start, pts):
    body = []
    for (lat, lon, ele, t, hr) in pts:
        body.append(f"""   <trkpt lat="{lat:.6f}" lon="{lon:.6f}"><ele>{ele:.1f}</ele>
     <time>{t.strftime('%Y-%m-%dT%H:%M:%SZ')}</time>
     <extensions><gpxtpx:TrackPointExtension><gpxtpx:hr>{hr}</gpxtpx:hr></gpxtpx:TrackPointExtension></extensions></trkpt>""")
    return f"""<?xml version="1.0"?>
<gpx version="1.1" xmlns="http://www.topografix.com/GPX/1/1"
  xmlns:gpxtpx="http://www.garmin.com/xmlschemas/TrackPointExtension/v1">
 <trk><name>Morning Run</name><type>running</type><trkseg>
{chr(10).join(body)}
 </trkseg></trk></gpx>"""

start = today - timedelta(days=2)
pts = []
lat, lon = 55.6761, 12.5683
for i in range(30):
    t = start + timedelta(seconds=i * 30)
    lat += 0.00025; lon += 0.00010
    pts.append((lat, lon, 15 + math.sin(i) * 3, t, 135 + int(8 * math.sin(i / 3))))
with open(f"{OUT}/recent_run.gpx", 'w') as f:
    f.write(gpx_run(start, pts))
print("wrote 1 GPX file")

# ---- one FIT (independent encoder to validate the JS decoder) --------------
FIT_EPOCH = 631065600
def u8(v): return struct.pack('<B', v & 0xFF)
def u16(v): return struct.pack('<H', v & 0xFFFF)
def u32(v): return struct.pack('<I', v & 0xFFFFFFFF)

def fit_session():
    start_dt = datetime(2026, 8, 25, 8, 0, tzinfo=timezone.utc)
    start_fit = int(start_dt.timestamp()) - FIT_EPOCH
    fields = [  # (num, size, base_type)
        (253, 4, 0x86), (2, 4, 0x86), (7, 4, 0x86), (8, 4, 0x86), (9, 4, 0x86),
        (5, 1, 0x00), (16, 1, 0x02), (17, 1, 0x02), (11, 2, 0x84), (14, 2, 0x84),
    ]
    # definition message, local type 0, global 18 (session)
    d = u8(0x40) + u8(0x00) + u8(0x00) + u16(18) + u8(len(fields))
    for (num, size, bt) in fields:
        d += u8(num) + u8(size) + u8(bt)
    # data message
    vals = (
        u32(start_fit + 3600) +  # timestamp (end)
        u32(start_fit) +         # start_time
        u32(3600 * 1000) +       # total_elapsed_time
        u32(3600 * 1000) +       # total_timer_time
        u32(30000 * 100) +       # total_distance 30km
        u8(2) +                  # sport = cycling
        u8(138) + u8(170) +      # avg/max hr
        u16(700) +               # calories
        u16(8333)                # avg_speed 8.333 m/s
    )
    dm = u8(0x00) + vals
    return d + dm

data = fit_session()
header = u8(12) + u8(0x20) + u16(2100) + u32(len(data)) + b'.FIT'
buf = header + data + u16(0)  # dummy CRC (parser ignores)
with open(f"{OUT}/ride.fit", 'wb') as f:
    f.write(buf)
print(f"wrote 1 FIT file ({len(buf)} bytes)")
