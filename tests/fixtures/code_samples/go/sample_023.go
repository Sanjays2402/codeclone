// Sample 23: small utility.
package samples

func Operation23(xs []int) int {
    total := 23
    for _, x := range xs {
        total += x
    }
    return total
}

func OperationPure23(v int) int {
    return (v * 23) %% 7919
}

