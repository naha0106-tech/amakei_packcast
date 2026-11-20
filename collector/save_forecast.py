
"""
매일 주요 도시의 앙상블 예보(82개 시나리오)를 받아 data/ 폴더에 저장합니다.
나중에 실제 관측과 비교해서 적중률을 계산하는 데 씁니다.
 
- 외부 패키지 없이 파이썬 기본 기능만 씁니다 (pip 설치 필요 없음).
- 저장 위치: data/YYYY-MM-DD/<도시>.json
"""
 
import json
import os
import sys
import time
import urllib.parse
import urllib.request
from datetime import datetime, timedelta, timezone
 
KST = timezone(timedelta(hours=9))
 
# 저장할 도시 (이름, 위도, 경도)
# 수도권 / 강원(영서·영동) / 충청 / 호남(내륙·해안) / 영남(내륙·해안) / 제주(북·남)를 고루 포함
CITIES = [
    ("seoul", 37.5665, 126.9780),
    ("incheon", 37.4563, 126.7052),
    ("suwon", 37.2636, 127.0286),
    ("chuncheon", 37.8813, 127.7298),
    ("wonju", 37.3422, 127.9202),
    ("gangneung", 37.7519, 128.8761),
    ("cheongju", 36.6424, 127.4890),
    ("daejeon", 36.3504, 127.3845),
    ("jeonju", 35.8242, 127.1480),
    ("gwangju", 35.1595, 126.8526),
    ("mokpo", 34.8118, 126.3922),
    ("yeosu", 34.7604, 127.6622),
    ("daegu", 35.8714, 128.6014),
    ("andong", 36.5684, 128.7294),
    ("pohang", 36.0190, 129.3435),
    ("ulsan", 35.5384, 129.3114),
    ("busan", 35.1796, 129.0756),
    ("changwon", 35.2280, 128.6811),
    ("jeju", 33.4996, 126.5312),
    ("seogwipo", 33.2541, 126.5600),
]
 
API_URL = "https://ensemble-api.open-meteo.com/v1/ensemble"
 
PARAMS = {
    "hourly": "temperature_2m,apparent_temperature,precipitation,rain,snowfall,wind_speed_10m",
    "models": "ecmwf_ifs025,gfs025",   # ECMWF 51개 + GFS 31개 = 82개
    "timezone": "Asia/Seoul",
    "forecast_days": 2,                # 검증에는 오늘·내일이면 충분 (저장 용량 절약)
    "wind_speed_unit": "ms",
}
 
 
def fetch(lat, lon, retries=3):
    """예보를 받아옵니다. 실패하면 잠깐 쉬었다가 최대 3번까지 다시 시도합니다."""
    query = dict(PARAMS, latitude=lat, longitude=lon)
    url = API_URL + "?" + urllib.parse.urlencode(query)
    last_error = None
    for attempt in range(1, retries + 1):
        try:
            with urllib.request.urlopen(url, timeout=60) as resp:
                return json.loads(resp.read().decode("utf-8"))
        except Exception as e:  # 네트워크 오류, 서버 오류 등
            last_error = e
            print(f"  시도 {attempt}회 실패: {e}")
            time.sleep(10 * attempt)
    raise RuntimeError(f"예보 받기 실패: {last_error}")
 
 
def main():
    now = datetime.now(KST)
    day_dir = os.path.join("data", now.strftime("%Y-%m-%d"))
    os.makedirs(day_dir, exist_ok=True)
 
    ok, failed = 0, []
    for name, lat, lon in CITIES:
        print(f"[{name}] 예보 받는 중...")
        try:
            data = fetch(lat, lon)
        except Exception as e:
            print(f"  -> 건너뜀: {e}")
            failed.append(name)
            continue
 
        record = {
            "city": name,
            "lat": lat,
            "lon": lon,
            "fetched_at": now.isoformat(timespec="seconds"),
            "params": PARAMS,
            "forecast": data,
        }
        path = os.path.join(day_dir, f"{name}.json")
        with open(path, "w", encoding="utf-8") as f:
            json.dump(record, f, ensure_ascii=False, separators=(",", ":"))
        print(f"  -> 저장: {path}")
        ok += 1
        time.sleep(1)  # 서버에 부담 주지 않도록 잠깐 쉬기
 
    print(f"\n완료: 성공 {ok}곳, 실패 {len(failed)}곳 {failed}")
    if ok == 0:
        sys.exit(1)  # 하나도 못 받았으면 GitHub에서 실패로 표시
 
 
if __name__ == "__main__":
    main()
 
