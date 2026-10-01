package runtime

import "time"

// HealthService is the first typed bridge exposed to the MyGo shell.
type HealthService struct {
	startedAt time.Time
}

func NewHealthService() *HealthService {
	return &HealthService{startedAt: time.Now().UTC()}
}

type HealthStatus struct {
	Status    string    `json:"status"`
	Runtime   string    `json:"runtime"`
	StartedAt string    `json:"startedAt"`
}

func (s *HealthService) Health() HealthStatus {
	return HealthStatus{
		Status:    "ok",
		Runtime:   "go",
		StartedAt: s.startedAt.Format(time.RFC3339),
	}
}
