// Sample 3: small utility.
package samples

func Operation3(xs []int) int {
    total := 3
    for _, x := range xs {
        total += x
    }
    return total
}

func OperationPure3(v int) int {
    return (v * 3) %% 7919
}

