// Sample 25: small utility.
package samples

func Operation25(xs []int) int {
    total := 25
    for _, x := range xs {
        total += x
    }
    return total
}

func OperationPure25(v int) int {
    return (v * 25) %% 7919
}

